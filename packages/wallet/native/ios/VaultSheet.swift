import UIKit

// The vault's native sheet (sealed core): it says what will be signed, from native state, and
// takes the recovery phrase where JavaScript can't see it.
//
// The phrase is typed a word at a time, into a numbered box per word, so one mistyped word can
// be found and fixed on its own. The words never live in Swift:
// a box is a bare key-input view, not a text field, and each keystroke goes straight to the
// Rust PhraseBuffer, which keeps the words in buffers it wipes. Back come only what the box
// draws: the word's length, as dots, and whether it's on the BIP-39 list. Signing reads the
// phrase from the buffer too. What Swift still touches, and can't wipe: the one-character
// string the keyboard hands over per keystroke, and a pasted phrase as the pasteboard gives it.
//
// The boxes are secure input (the system keyboard only, no autocorrect, suggestions or
// learning) and there's deliberately no way to reveal the words: shown, they'd be text that
// screenshots, screen recording and third-party keyboards can reach. Every word is wiped when
// the app leaves the foreground, and a paste empties the clipboard.

/// One numbered box: a key-input view that keeps no text of its own.
final class WordBox: UIControl, UIKeyInput {
  let index: Int
  /// The sheet routes every keystroke to the buffer.
  weak var sheet: VaultSheet?
  private let number = UILabel()
  private let dots = UILabel()

  // Secure input: the system keyboard only, nothing remembered or suggested.
  var isSecureTextEntry = true
  var autocorrectionType: UITextAutocorrectionType = .no
  var autocapitalizationType: UITextAutocapitalizationType = .none
  var spellCheckingType: UITextSpellCheckingType = .no
  var smartQuotesType: UITextSmartQuotesType = .no
  var smartDashesType: UITextSmartDashesType = .no
  var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
  var keyboardType: UIKeyboardType = .asciiCapable
  var returnKeyType: UIReturnKeyType = .next
  var textContentType: UITextContentType! = nil

  init(index: Int) {
    self.index = index
    super.init(frame: .zero)
    layer.cornerRadius = 10
    layer.borderWidth = 1
    backgroundColor = .secondarySystemBackground

    number.text = "\(index + 1)"
    number.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
    number.textColor = .secondaryLabel
    number.textAlignment = .right
    number.widthAnchor.constraint(equalToConstant: 20).isActive = true
    dots.font = .preferredFont(forTextStyle: .body)
    dots.adjustsFontForContentSizeCategory = true
    dots.textColor = .label

    let row = UIStackView(arrangedSubviews: [number, dots])
    row.spacing = 6
    row.isUserInteractionEnabled = false
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      row.topAnchor.constraint(equalTo: topAnchor),
      row.bottomAnchor.constraint(equalTo: bottomAnchor),
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])

    isAccessibilityElement = true
    accessibilityLabel = "Word \(index + 1)"
    addTarget(self, action: #selector(tapped), for: .touchUpInside)
    show(length: 0, wrong: false)
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  @objc private func tapped() { _ = becomeFirstResponder() }

  override var canBecomeFirstResponder: Bool { true }

  override func becomeFirstResponder() -> Bool {
    let ok = super.becomeFirstResponder()
    if ok { sheet?.focused(self) }
    return ok
  }

  override func resignFirstResponder() -> Bool {
    let ok = super.resignFirstResponder()
    if ok { sheet?.refresh() }
    return ok
  }

  // UIKeyInput: nothing is stored here.
  var hasText: Bool { (sheet?.length(of: index) ?? 0) > 0 }
  func insertText(_ text: String) { sheet?.typed(text, into: index) }
  func deleteBackward() { sheet?.backspace(at: index) }

  private var wrong = false

  func show(length: Int, wrong: Bool) {
    self.wrong = wrong
    dots.text = length == 0 ? " " : String(repeating: "•", count: length)
    let color: UIColor = wrong ? .systemRed : isFirstResponder ? .tintColor : .separator
    layer.borderColor = color.cgColor
    layer.borderWidth = wrong || isFirstResponder ? 2 : 1
    accessibilityValue = length == 0 ? "Empty" : "\(length) letters\(wrong ? ", not on the word list" : "")"
  }

  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    // CGColors don't follow light and dark mode by themselves.
    sheet?.refresh()
  }
}

final class VaultSheet: UIViewController {
  private static let lengths: [UInt32] = [12, 15, 18, 21, 24]
  private static let columns = 3

  private let heading: String
  private let message: String
  private let actionTitle: String
  private let phrase: PhraseBuffer
  private var completion: ((Bool) -> Void)?

  private let boxes = (0..<24).map { WordBox(index: $0) }
  private var rows: [UIStackView] = []
  private let lengthPicker = UISegmentedControl(items: VaultSheet.lengths.map { "\($0)" })
  private let paste = UIButton(type: .system)
  private let status = UILabel()
  private let approve = UIButton(type: .system)
  private let scroll = UIScrollView()

  init(heading: String, message: String, actionTitle: String, phrase: PhraseBuffer, completion: @escaping (Bool) -> Void) {
    self.heading = heading
    self.message = message
    self.actionTitle = actionTitle
    self.phrase = phrase
    self.completion = completion
    super.init(nibName: nil, bundle: nil)
    isModalInPresentation = true
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  private var count: Int { Int(phrase.length()) }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    let title = UILabel()
    title.text = heading
    title.font = .preferredFont(forTextStyle: .title2)
    title.numberOfLines = 0

    let body = UILabel()
    body.text = message
    body.font = .preferredFont(forTextStyle: .body)
    body.numberOfLines = 0

    lengthPicker.accessibilityLabel = "Number of words"
    lengthPicker.addTarget(self, action: #selector(lengthChanged), for: .valueChanged)
    let lengthLabel = UILabel()
    lengthLabel.text = "Words"
    lengthLabel.font = .preferredFont(forTextStyle: .subheadline)
    lengthLabel.textColor = .secondaryLabel
    lengthLabel.setContentHuggingPriority(.required, for: .horizontal)
    paste.setTitle("Paste", for: .normal)
    paste.setContentHuggingPriority(.required, for: .horizontal)
    paste.addTarget(self, action: #selector(pastePhrase), for: .touchUpInside)
    let controls = UIStackView(arrangedSubviews: [lengthLabel, lengthPicker, paste])
    controls.spacing = 12
    controls.alignment = .center

    for box in boxes { box.sheet = self }
    rows = stride(from: 0, to: boxes.count, by: Self.columns).map { start in
      let row = UIStackView(arrangedSubviews: Array(boxes[start..<min(start + Self.columns, boxes.count)]))
      row.distribution = .fillEqually
      row.spacing = 8
      return row
    }
    let grid = UIStackView(arrangedSubviews: rows)
    grid.axis = .vertical
    grid.spacing = 8

    status.font = .preferredFont(forTextStyle: .footnote)
    status.numberOfLines = 0

    let privacy = UILabel()
    privacy.text = "Your phrase stays on this phone and is forgotten as soon as this is signed."
    privacy.font = .preferredFont(forTextStyle: .footnote)
    privacy.textColor = .secondaryLabel
    privacy.numberOfLines = 0

    approve.setTitle(actionTitle, for: .normal)
    approve.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    approve.isEnabled = false
    approve.addTarget(self, action: #selector(submit), for: .touchUpInside)

    let cancel = UIButton(type: .system)
    cancel.setTitle("Cancel", for: .normal)
    cancel.addTarget(self, action: #selector(dismissCancelled), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [title, body, controls, grid, status, privacy, approve, cancel])
    stack.axis = .vertical
    stack.spacing = 16
    stack.setCustomSpacing(8, after: grid)
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.keyboardDismissMode = .interactive
    scroll.addSubview(stack)
    view.addSubview(scroll)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -20),
    ])

    NotificationCenter.default.addObserver(self, selector: #selector(resignedActive), name: UIApplication.willResignActiveNotification, object: nil)
    applyLength()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    focus(0)
  }

  /// Closed some other way than its buttons (the app dismissed everything presented, say):
  /// that's a cancel, so the vault doesn't wait on a sheet that's gone.
  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    guard let done = completion else { return }
    completion = nil
    NotificationCenter.default.removeObserver(self, name: UIApplication.willResignActiveNotification, object: nil)
    phrase.clear()
    done(false)
  }

  // MARK: Typing, from the boxes

  func length(of index: Int) -> Int { Int(phrase.wordLength(index: UInt32(index))) }

  func typed(_ text: String, into index: Int) {
    if text == "\n" {
      if index == count - 1 {
        if approve.isEnabled { submit() }
      } else {
        focus(index + 1)
      }
      return
    }
    var bytes = Data(text.utf8)
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    if phrase.typeInto(index: UInt32(index), input: bytes) == .next, length(of: index) > 0 { focus(index + 1) }
    refresh()
  }

  func backspace(at index: Int) {
    if !phrase.backspace(index: UInt32(index)) { focus(index - 1) }
    refresh()
  }

  func focused(_ box: WordBox) {
    refresh()
    scroll.scrollRectToVisible(box.convert(box.bounds.insetBy(dx: 0, dy: -24), to: scroll), animated: true)
  }

  private func focus(_ i: Int) {
    guard i >= 0, i < count else { return }
    _ = boxes[i].becomeFirstResponder()
  }

  /// The pasteboard's phrase into the buffer from the focused box, then the pasteboard is
  /// emptied. Its string is the one copy Swift can't wipe.
  @objc private func pastePhrase() {
    guard let text = UIPasteboard.general.string else { return }
    UIPasteboard.general.items = []
    var bytes = Data(text.utf8)
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    let from = boxes.prefix(count).firstIndex(where: \.isFirstResponder) ?? 0
    let next = Int(phrase.paste(index: UInt32(from), input: bytes))
    applyLength()
    focus(min(next, count - 1))
  }

  // MARK: State

  /// A box is wrong as soon as no word starts that way, and once it's left if it isn't a word.
  func refresh() {
    var wrong: [Int] = []
    for i in 0..<count {
      let s = phrase.wordStatus(index: UInt32(i))
      let isWrong = s == .wrong || (s == .partial && !boxes[i].isFirstResponder)
      if isWrong { wrong.append(i) }
      boxes[i].show(length: length(of: i), wrong: isWrong)
    }
    let filled = Int(phrase.filled())
    let valid = filled == count && phrase.isValid()
    approve.isEnabled = valid
    status.textColor = wrong.isEmpty && (valid || filled < count) ? .secondaryLabel : .systemRed
    if !wrong.isEmpty {
      let names = wrong.map { String($0 + 1) }
      status.text = wrong.count == 1
        ? "Word \(names[0]) isn't on the recovery phrase word list."
        : "Words \(names.dropLast().joined(separator: ", ")) and \(names.last!) aren't on the recovery phrase word list."
    } else if valid {
      status.text = "All \(count) words check out."
    } else if filled == count {
      status.text = "Every word is real, but together they don't check out. Look for two words in the wrong order, or one that looks like another."
    } else {
      status.text = "\(filled) of \(count) words"
    }
  }

  @objc private func lengthChanged() {
    _ = phrase.setLength(length: Self.lengths[lengthPicker.selectedSegmentIndex])
    applyLength()
  }

  /// Shows the boxes for the buffer's length (the buffer has wiped the words past it).
  private func applyLength() {
    if let i = Self.lengths.firstIndex(of: UInt32(count)) { lengthPicker.selectedSegmentIndex = i }
    for (i, box) in boxes.enumerated() {
      box.isHidden = i >= count
      box.returnKeyType = i == count - 1 ? .done : .next
      if box.isHidden && box.isFirstResponder { _ = box.resignFirstResponder() }
    }
    for row in rows { row.isHidden = row.arrangedSubviews.allSatisfy(\.isHidden) }
    refresh()
  }

  /// Leaving the app wipes every word, so the phrase never waits in the background. Only
  /// while the sheet is open: once approved, signing owns the buffer and wipes it when done.
  @objc private func resignedActive() {
    guard completion != nil else { return }
    phrase.clear()
    refresh()
  }

  @objc private func submit() {
    finish(true)
  }

  @objc private func dismissCancelled() {
    phrase.clear()
    finish(false)
  }

  private func finish(_ approved: Bool) {
    guard let done = completion else { return }
    completion = nil
    // From here the buffer is the signer's (or already wiped): the app going to the background
    // during the dismissal or the signing no longer clears it out from under the signature.
    NotificationCenter.default.removeObserver(self, name: UIApplication.willResignActiveNotification, object: nil)
    view.endEditing(true)
    dismiss(animated: true) { done(approved) }
  }
}
