import Foundation
import Security

// The phone's app key records (sealed core): each is an Ed25519 seed and its state, kept in
// one Keychain item so they change together. There are at most two: `current`, the account's
// key, and `next`, a renewal's replacement waiting for the vault while the current key keeps
// working. The items are this-device-only and exist only while the phone has a passcode: iOS
// deletes them if the passcode is removed, and they never sync to iCloud or backups. The seed
// is read here and handed straight to Rust; nothing in this file gives it to JavaScript.
//
// Each record is wrapped with a Secure Enclave P-256 key: the Enclave
// can't hold an Ed25519 key, so it holds the key that decrypts the record instead, and that key
// never leaves the chip. Records written before wrapping are wrapped the first time they're read.
//
// A key that may be registered on the network is never deleted because it couldn't be read:
// a locked Keychain or a record from a newer app version is an error, not an empty store, and
// writes replace the item in place rather than delete-then-add, so a failed write keeps the
// old key.

struct PendingSignIn: Codable, Equatable {
  let fid: UInt64
  let nonce: UInt32
  /** Farcaster time. */
  let deadline: UInt32
  /** The custody address, as 0x-prefixed hex. */
  let custody: String
}

struct AppKeyState: Codable {
  /// The record's format. Absent in records written before it was added, which are format 1.
  var v: Int? = AppKeyState.format
  let publicKey: String
  var fid: UInt64?
  var pending: PendingSignIn?

  static let format = 1
}

enum StoreError: Error {
  case noPasscode
  case keychain(OSStatus)
  /// The item's bytes don't decode as any record, or the key that wraps them is gone: nothing
  /// in it can sign.
  case corrupt
  /// Written by a newer version of the app: kept as it is.
  case newerFormat
}

/// The Secure Enclave key that wraps every app key record. It's made once, can be used only
/// while the phone is unlocked and has a passcode, and never leaves the Enclave.
private enum WrappingKey {
  static let tag = Data("xyz.warpstack.app-key.wrap".utf8)
  static let algorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
  /// The key is made once, whichever slot asks first.
  static let lock = NSLock()

  private static var query: [String: Any] {
    [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom]
  }

  /// The private key, or nil if it doesn't exist.
  static func find() throws -> SecKey? {
    var q = query
    q[kSecReturnRef as String] = true
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let ref = out, CFGetTypeID(ref) == SecKeyGetTypeID() else { throw StoreError.keychain(status) }
    return (ref as! SecKey)
  }

  static func findOrMake() throws -> SecKey {
    lock.lock()
    defer { lock.unlock() }
    if let key = try find() { return key }
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .privateKeyUsage, nil) else {
      throw StoreError.keychain(errSecParam)
    }
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: access,
      ] as [String: Any],
    ]
    #if !targetEnvironment(simulator)
    // The Simulator has no Secure Enclave: there the same key is made in software.
    attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    #endif
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw storeError(error?.takeRetainedValue())
    }
    return key
  }

  static func storeError(_ e: CFError?) -> StoreError {
    let status = e.map { OSStatus(CFErrorGetCode($0)) } ?? errSecInternalError
    if status == errSecAuthFailed || status == errSecNotAvailable { return .noPasscode }
    return .keychain(status)
  }

  static func wrap(_ plain: Data) throws -> Data {
    guard let pub = SecKeyCopyPublicKey(try findOrMake()), SecKeyIsAlgorithmSupported(pub, .encrypt, algorithm) else {
      throw StoreError.keychain(errSecUnimplemented)
    }
    var error: Unmanaged<CFError>?
    guard let sealed = SecKeyCreateEncryptedData(pub, algorithm, plain as CFData, &error) else {
      throw storeError(error?.takeRetainedValue())
    }
    return sealed as Data
  }

  /// Throws `corrupt` only when the bytes can never be read: there's no wrapping key, or
  /// decryption fails for a reason other than the phone being locked.
  static func unwrap(_ sealed: Data) throws -> Data {
    guard let key = try find() else { throw StoreError.corrupt }
    var error: Unmanaged<CFError>?
    guard let plain = SecKeyCreateDecryptedData(key, algorithm, sealed as CFData, &error) else {
      let status = error.map { OSStatus(CFErrorGetCode($0.takeRetainedValue())) } ?? errSecInternalError
      if status == errSecInteractionNotAllowed { throw StoreError.keychain(status) }
      throw StoreError.corrupt
    }
    return plain as Data
  }
}

final class AppKeyStore {
  private let service = "xyz.warpstack.app-key"
  private let account: String
  /// Marks an item whose data is wrapped. Items without it were written before wrapping.
  private static let wrapped = Data("wrapped-se-p256".utf8)

  init(account: String) {
    self.account = account
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  /// The seed and the state, or nil when there's no key. The caller wipes the seed after use.
  /// Throws `keychain` when the Keychain can't be read (the phone is locked, say), `corrupt` when
  /// the item holds no readable record, and `newerFormat` for a record this version can't read.
  func load() throws -> (seed: Data, state: AppKeyState)? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let item = out as? [String: Any], var stored = item[kSecValueData as String] as? Data else {
      throw StoreError.keychain(status)
    }
    defer { stored.resetBytes(in: 0..<stored.count) }
    let isWrapped = item[kSecAttrGeneric as String] as? Data == Self.wrapped
    var data = isWrapped ? try WrappingKey.unwrap(stored) : stored
    defer { data.resetBytes(in: 0..<data.count) }
    guard data.count > 32, let state = try? JSONDecoder().decode(AppKeyState.self, from: data.subdata(in: 32..<data.count)) else {
      throw StoreError.corrupt
    }
    if (state.v ?? 1) > AppKeyState.format { throw StoreError.newerFormat }
    // A copy of its own, so wiping `data` doesn't touch it and the caller can wipe it.
    let seed = Data(data.prefix(32))
    // A record from before wrapping is wrapped now. If that fails, it's read as it is and
    // wrapped on a later read.
    if !isWrapped { try? save(seed: seed, state: state) }
    return (seed, state)
  }

  /// Writes the key and its state, wrapped, in place of whatever was there, in one Keychain operation.
  func save(seed: Data, state: AppKeyState) throws {
    precondition(seed.count == 32)
    var record = state
    record.v = AppKeyState.format
    var plain = seed
    plain.append(try JSONEncoder().encode(record))
    defer { plain.resetBytes(in: 0..<plain.count) }
    let data = try WrappingKey.wrap(plain)
    let update: [String: Any] = [kSecValueData as String: data, kSecAttrGeneric as String: Self.wrapped]
    var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var q = query
      q.merge(update) { $1 }
      q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
      status = SecItemAdd(q as CFDictionary, nil)
    }
    if status == errSecDecode || status == errSecAuthFailed || status == errSecNotAvailable { throw StoreError.noPasscode }
    guard status == errSecSuccess else { throw StoreError.keychain(status) }
  }

  func delete() {
    SecItemDelete(query as CFDictionary)
  }
}
