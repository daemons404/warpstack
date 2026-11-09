import ExpoModulesCore
import Foundation
import Security
import UIKit

// The native vault's bridge to JavaScript (sealed core).
// JavaScript gets public keys, signatures and the account state, and never the seed or the
// phrase. It can ask for two kinds of thing:
//
// - App key signatures over `MessageData` bytes, each with a purpose that Rust checks against
//   the decoded bytes and the FID stored here (not one JavaScript passes).
// - A custody signature from the transient vault, which shows a native sheet built from the
//   state stored here and takes the phrase in a native field. A key add takes no arguments:
//   it can only add this phone's own pending key, for the sign-in stored with it.
//
// Renewal adds before it forgets: while the current key is registered, `create` makes the
// replacement in a second slot, the current key keeps signing until the node lists the new
// one, and `activate` then puts the new key in the current slot in one write. The old key is
// forgotten here and expires on its own on the network.

private let farcasterEpoch: TimeInterval = 1_609_459_200

private func farcasterNow() -> UInt32 {
  UInt32(max(0, Date().timeIntervalSince1970 - farcasterEpoch))
}

private func hex(_ d: Data) -> String {
  "0x" + d.map { String(format: "%02x", $0) }.joined()
}

/// `0x` and an even number of hex digits, nothing else: `UInt8(_:radix:)` alone also takes a
/// sign, so "0x+a" would decode, and two spellings of one key could compare unequal as strings.
private func unhex(_ s: String, count: Int? = nil) -> Data? {
  let u = Array(s.utf8)
  guard u.count >= 2, u[0] == 0x30, u[1] == 0x78, u.count % 2 == 0 else { return nil }
  func nibble(_ c: UInt8) -> UInt8? {
    switch c {
    case 0x30...0x39: return c - 0x30
    case 0x61...0x66: return c - 0x61 + 10
    case 0x41...0x46: return c - 0x41 + 10
    default: return nil
    }
  }
  var out = Data(capacity: (u.count - 2) / 2)
  var i = 2
  while i < u.count {
    guard let hi = nibble(u[i]), let lo = nibble(u[i + 1]) else { return nil }
    out.append(hi << 4 | lo)
    i += 2
  }
  if let count, out.count != count { return nil }
  return out
}

/// A count or FID from JavaScript as an unsigned value, or nil if it's out of range, rather
/// than a trap on a negative number.
private func unsigned<T: FixedWidthInteger & UnsignedInteger>(_ n: Int, min: T = 0) -> T? {
  guard n >= 0, let v = T(exactly: n), v >= min else { return nil }
  return v
}

/// The same fingerprint `protocol`'s `keyFingerprint` shows: 80 bits in five groups.
private func fingerprint(_ key: Data) -> String {
  let h = key.prefix(10).map { String(format: "%02X", $0) }.joined()
  return stride(from: 0, to: 20, by: 4).map { i in
    String(h[h.index(h.startIndex, offsetBy: i)..<h.index(h.startIndex, offsetBy: i + 4)])
  }.joined(separator: "-")
}

final class VaultException: Exception, @unchecked Sendable {
  private let text: String
  init(_ text: String) {
    self.text = text
    super.init()
  }
  override var reason: String { text }
}

private func describe(_ e: Error) -> String {
  if let v = e as? VaultError {
    switch v {
    case .Refused(let reason): return reason
    case .InvalidPhrase: return "That isn't a valid recovery phrase."
    case .NoMatchingAccount: return "This phrase doesn't hold the account's custody address. Check that it's the phrase for this account."
    }
  }
  if let s = e as? StoreError {
    switch s {
    case .noPasscode: return "Set a passcode on this phone first: the app key is stored only while the phone has one."
    case .keychain(let status): return "The Keychain refused (\(status))."
    case .corrupt: return "The stored key is unreadable. Sign in again."
    case .newerFormat: return "This phone's key was saved by a newer version of the app. Update the app."
    }
  }
  return "\(e)"
}

public class WarpstackVaultModule: Module {
  private let store = AppKeyStore(account: "current")
  /// A renewal's replacement key, waiting for the vault's approval.
  private let next = AppKeyStore(account: "next")
  /// Keychain changes happen one at a time.
  private let lock = NSLock()
  private var sheetOpen = false

  private func locked<T>(_ f: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    return try f()
  }

  private func stateDict(_ s: AppKeyState) -> [String: Any] {
    var out: [String: Any] = ["publicKey": s.publicKey, "fid": s.fid.map { Int($0) as Any } ?? NSNull()]
    if let p = s.pending {
      out["pending"] = ["fid": Int(p.fid), "nonce": Int(p.nonce), "deadline": Int(p.deadline), "custody": p.custody]
    }
    return out
  }

  /// The renewal key waiting for approval, if `cur` is registered and one is stored for its FID.
  /// An unreadable one counts as none: nothing has registered it, and the next renewal replaces
  /// it. One with the current key's own bytes is what's left of a finished renewal. The caller
  /// wipes the seed.
  private func renewal(of cur: AppKeyState) -> (seed: Data, state: AppKeyState)? {
    guard let fid = cur.fid, var n = try? self.next.load() else { return nil }
    guard n.state.fid == nil, n.state.pending?.fid == fid, let key = unhex(n.state.publicKey, count: 32),
          key != unhex(cur.publicKey, count: 32) else {
      n.seed.resetBytes(in: 0..<n.seed.count)
      return nil
    }
    return n
  }

  /// Presents the vault sheet; `sign` runs off the main thread with the phrase the person
  /// typed, which stays in the Rust buffer: Swift never holds it. The buffer is wiped once
  /// signed or cancelled.
  private func askForPhrase<T>(heading: String, message: String, action: String, promise: Promise, sign: @escaping (PhraseBuffer) throws -> T, done: @escaping (T) -> [String: Any]) {
    guard !sheetOpen, let top = appContext?.utilities?.currentViewController() else {
      promise.reject(VaultException("The vault is already open."))
      return
    }
    sheetOpen = true
    let phrase = PhraseBuffer(length: 24)
    let sheet = VaultSheet(heading: heading, message: message, actionTitle: action, phrase: phrase) { [weak self] approved in
      self?.sheetOpen = false
      guard approved else {
        phrase.clear()
        promise.reject("ERR_CANCELLED", "Cancelled.")
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        defer { phrase.clear() }
        do {
          promise.resolve(done(try sign(phrase)))
        } catch {
          promise.reject(VaultException(describe(error)))
        }
      }
    }
    top.present(sheet, animated: true)
  }

  public func definition() -> ModuleDefinition {
    Name("WarpstackVault")

    /// The stored account, or nil, with the renewal key waiting for approval as `next`. An
    /// unreadable item reads as no key but stays in place until a new sign-in replaces it; a
    /// locked Keychain or a newer record is an error.
    AsyncFunction("current") { () throws -> [String: Any]? in
      try self.locked {
        do {
          guard var cur = try self.store.load() else { return nil }
          cur.seed.resetBytes(in: 0..<cur.seed.count)
          var out = self.stateDict(cur.state)
          if var n = self.renewal(of: cur.state), let p = n.state.pending {
            n.seed.resetBytes(in: 0..<n.seed.count)
            out["next"] = ["publicKey": n.state.publicKey, "pending": ["fid": Int(p.fid), "nonce": Int(p.nonce), "deadline": Int(p.deadline), "custody": p.custody]]
          }
          return out
        } catch StoreError.corrupt {
          return nil
        } catch {
          throw VaultException(describe(error))
        }
      }
    }

    /// Makes a new, unregistered key for a sign-in. While a registered key exists, it makes
    /// that key's replacement for a renewal instead, for the same FID, and leaves it in place.
    AsyncFunction("create") { (fid: Int, nonce: Int, deadline: Int, custody: String) throws -> String in
      guard let fid: UInt64 = unsigned(fid, min: 1), let nonce: UInt32 = unsigned(nonce), let deadline: UInt32 = unsigned(deadline, min: 1),
            unhex(custody, count: 20) != nil else {
        throw VaultException("Bad sign-in request.")
      }
      return try self.locked {
        // Replaces nothing it can't read: only no key, a pending one, or an unreadable item.
        var slot = self.store
        do {
          if var cur = try self.store.load() {
            cur.seed.resetBytes(in: 0..<cur.seed.count)
            if let signedIn = cur.state.fid {
              guard signedIn == fid else { throw VaultException("This phone is signed in as FID \(signedIn). Sign out first.") }
              slot = self.next
            }
          }
        } catch StoreError.corrupt {
          // Nothing in it can sign; the new key takes its place.
        } catch let e as VaultException {
          throw e
        } catch {
          throw VaultException(describe(error))
        }
        // A renewal key belongs to a registered key; without one it's left over.
        if slot === self.store { self.next.delete() }
        var seed = Data(count: 32)
        let status = seed.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        defer { seed.resetBytes(in: 0..<32) }
        guard status == errSecSuccess else { throw VaultException("No randomness available.") }
        let publicKey = hex(try appKeyPublicKey(seedBytes: seed))
        let pending = PendingSignIn(fid: fid, nonce: nonce, deadline: deadline, custody: custody.lowercased())
        do {
          try slot.save(seed: seed, state: AppKeyState(publicKey: publicKey, fid: nil, pending: pending))
        } catch {
          throw VaultException(describe(error))
        }
        return publicKey
      }
    }

    /// Marks the key registered once its `KEY_ADD` has merged. A renewal key takes the current
    /// key's place in one write, and the current key is forgotten.
    AsyncFunction("activate") { (publicKey: String, fid: Int) throws in
      guard let fid: UInt64 = unsigned(fid, min: 1), let key = unhex(publicKey, count: 32) else { throw VaultException("Bad key.") }
      try self.locked {
        guard var cur = try self.store.load() else { throw VaultException("The key changed. Start again.") }
        defer { cur.seed.resetBytes(in: 0..<cur.seed.count) }
        do {
          if unhex(cur.state.publicKey, count: 32) == key, cur.state.fid == nil, cur.state.pending?.fid == fid {
            try self.store.save(seed: cur.seed, state: AppKeyState(publicKey: cur.state.publicKey, fid: fid, pending: nil))
            return
          }
          guard cur.state.fid == fid, var n = self.renewal(of: cur.state), unhex(n.state.publicKey, count: 32) == key else {
            throw VaultException("The key changed. Start again.")
          }
          defer { n.seed.resetBytes(in: 0..<n.seed.count) }
          try self.store.save(seed: n.seed, state: AppKeyState(publicKey: n.state.publicKey, fid: fid, pending: nil))
          // If this fails, what's left has the current key's bytes and reads as no renewal.
          self.next.delete()
        } catch let e as VaultException {
          throw e
        } catch {
          throw VaultException(describe(error))
        }
      }
    }

    /// Forgets the key, if it's still the one named: the current key, with any renewal key
    /// waiting on it, or just the renewal key. An unreadable item goes too; a Keychain that
    /// can't be read, or a newer record, is left alone.
    AsyncFunction("clear") { (publicKey: String) throws in
      guard let key = unhex(publicKey, count: 32) else { throw VaultException("Bad key.") }
      try self.locked {
        do {
          if var cur = try self.store.load() {
            cur.seed.resetBytes(in: 0..<cur.seed.count)
            if unhex(cur.state.publicKey, count: 32) != key {
              if var n = try? self.next.load() {
                n.seed.resetBytes(in: 0..<n.seed.count)
                if unhex(n.state.publicKey, count: 32) == key { self.next.delete() }
              }
              return
            }
          }
        } catch StoreError.corrupt {
          // Nothing in it can sign.
        } catch {
          throw VaultException(describe(error))
        }
        self.store.delete()
        self.next.delete()
      }
    }

    /// Signs `MessageData` bytes with the app key for one purpose, which Rust checks.
    AsyncFunction("sign") { (publicKey: String, purpose: String, data: String) throws -> [String: String] in
      guard let bytes = unhex(data), bytes.count <= 2_048, let key = unhex(publicKey, count: 32) else { throw VaultException("Bad message.") }
      // The current key, or for its own KEY_ADD only, the renewal key waiting on it.
      guard var cur = try self.locked({ () throws -> (seed: Data, state: AppKeyState)? in
        guard var c = try self.store.load() else { return nil }
        if unhex(c.state.publicKey, count: 32) == key || purpose != "ownKeyAdd" { return c }
        c.seed.resetBytes(in: 0..<c.seed.count)
        return self.renewal(of: c.state)
      }) else { throw VaultException("The key changed. Sign in again.") }
      defer { cur.seed.resetBytes(in: 0..<cur.seed.count) }
      guard unhex(cur.state.publicKey, count: 32) == key else { throw VaultException("The key changed. Sign in again.") }
      let p: SignPurpose
      switch (purpose, cur.state.fid) {
      // Its own KEY_ADD only for the FID its pending sign-in is for.
      case ("ownKeyAdd", nil):
        guard let pending = cur.state.pending else { throw VaultException("There's no sign-in waiting. Start again.") }
        p = .ownKeyAdd(fid: pending.fid)
      case ("posting", let fid?): p = .posting(fid: fid)
      case ("selfRemove", let fid?): p = .selfRemove(fid: fid)
      case ("custodyRemove", let fid?): p = .custodyRemove(fid: fid)
      default: throw VaultException("The app key doesn't sign this now.")
      }
      do {
        let s = try appKeySign(seedBytes: cur.seed, purpose: p, data: bytes)
        return ["hash": hex(s.hash), "signature": hex(s.signature)]
      } catch {
        throw VaultException(describe(error))
      }
    }

    /// Signs a session challenge with the registered app key. Rust builds the bytes from the
    /// origin and the 32-byte nonce, so JavaScript can't choose what the key signs.
    AsyncFunction("signSession") { (publicKey: String, origin: String, nonce: String) throws -> String in
      guard let nonceBytes = unhex(nonce, count: 32), origin.utf8.count <= 255, let key = unhex(publicKey, count: 32) else {
        throw VaultException("Bad session challenge.")
      }
      guard var cur = try self.locked({ try self.store.load() }) else { throw VaultException("The key changed. Sign in again.") }
      defer { cur.seed.resetBytes(in: 0..<cur.seed.count) }
      guard unhex(cur.state.publicKey, count: 32) == key, cur.state.fid != nil else {
        throw VaultException("The key changed. Sign in again.")
      }
      do {
        return hex(try appKeySignSession(seedBytes: cur.seed, origin: origin, nonce: nonceBytes))
      } catch {
        throw VaultException(describe(error))
      }
    }

    /// The vault's approval of this phone's pending key, or of the renewal key waiting on the
    /// current one, after the native sheet.
    AsyncFunction("approveKeyAdd") { (promise: Promise) in
      // Only the public key and the pending sign-in leave the store here; the vault never gets the seed.
      let waiting: (state: AppKeyState, renewing: Bool)? = try? self.locked {
        guard var cur = try self.store.load() else { return nil }
        cur.seed.resetBytes(in: 0..<cur.seed.count)
        if cur.state.fid == nil { return (cur.state, false) }
        guard var n = self.renewal(of: cur.state) else { return nil }
        n.seed.resetBytes(in: 0..<n.seed.count)
        return (n.state, true)
      }
      guard let w = waiting, w.state.fid == nil, let p = w.state.pending, let custody = unhex(p.custody, count: 20),
            let key = unhex(w.state.publicKey, count: 32) else {
        promise.reject(VaultException("There's no sign-in waiting. Start again."))
        return
      }
      guard p.deadline > farcasterNow() else {
        promise.reject(VaultException("The sign-in expired. Start again."))
        return
      }
      let can = "post and delete casts, like and recast, follow and unfollow, and edit the profile, including which verified address is primary"
      let cannot = "It can't move the account, change its recovery address or add other keys."
      let message = w.renewing
        ? """
          This replaces this phone's key for FID \(p.fid), which expires soon, with a new one that can do the same: \(can).

          \(cannot) The old key keeps working until the new one is active, then this phone forgets it and it expires on its own.

          New key \(fingerprint(key))
          """
        : """
          This lets this app post as FID \(p.fid): \(can).

          \(cannot) The key stays on this phone, expires 30 days after it was last used, and can be revoked from Settings or any other Farcaster app.

          Key \(fingerprint(key))
          """
      let heading = w.renewing ? "Renew FID \(p.fid)'s key" : "Sign in as FID \(p.fid)"
      self.askForPhrase(heading: heading, message: message, action: w.renewing ? "Renew" : "Approve", promise: promise, sign: { phrase in
        try approveKeyAdd(phrase: phrase, appKey: key, fid: p.fid, custody: custody, nonce: p.nonce, deadline: p.deadline, now: farcasterNow())
      }, done: { a in
        ["custodySignature": hex(a.custodySignature), "metadata": hex(a.metadata), "scopes": a.scopes.map { Int($0) }, "ttl": Int(a.ttl)]
      })
    }.runOnQueue(.main)

    /// The vault's custody removal of another of the account's keys, after the native sheet.
    AsyncFunction("approveKeyRemove") { (keyHex: String, custodyHex: String, nonce: Int, deadline: Int, promise: Promise) in
      guard var cur = try? self.store.load(), let fid = cur.state.fid else {
        promise.reject(VaultException("Sign in first."))
        return
      }
      cur.seed.resetBytes(in: 0..<cur.seed.count)
      guard let key = unhex(keyHex, count: 32), let custody = unhex(custodyHex, count: 20),
            let nonce: UInt32 = unsigned(nonce), let deadline: UInt32 = unsigned(deadline, min: 1) else {
        promise.reject(VaultException("Bad request."))
        return
      }
      // Compared as bytes: two spellings of one key are one key.
      guard key != unhex(cur.state.publicKey, count: 32) else {
        promise.reject(VaultException("Sign out to revoke this phone's own key."))
        return
      }
      let message = """
        This removes key \(fingerprint(key)) from FID \(fid). Whatever is signed in with it, another phone, a browser or another app, is signed out.
        """
      self.askForPhrase(heading: "Revoke a key", message: message, action: "Revoke", promise: promise, sign: { phrase in
        try approveKeyRemove(phrase: phrase, fid: fid, key: key, custody: custody, nonce: nonce, deadline: deadline, now: farcasterNow())
      }, done: { a in
        ["signature": hex(a.signature)]
      })
    }.runOnQueue(.main)
  }
}
