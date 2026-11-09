//! The recovery phrase while it's being typed: the words live
//! here, in buffers that are wiped when they change and when the buffer is dropped, so the
//! phrase never becomes a platform string. The native sheet sends one keystroke at a time and
//! gets back only what it draws: each word's length (as dots) and whether it's on the BIP-39
//! list. Signing reads the phrase from here, so it never crosses back to the platform.

use std::sync::Mutex;

use alloy_signer_local::coins_bip39::{English, Wordlist};
use zeroize::{Zeroize, Zeroizing};

/// The BIP-39 lengths.
pub const LENGTHS: [u32; 5] = [12, 15, 18, 21, 24];
/// The English list's longest word.
pub const LONGEST_WORD: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum WordStatus {
    Empty,
    /// The start of at least one word, but not a word yet.
    Partial,
    /// A word on the list (it may also start a longer one).
    Word,
    /// No word starts this way.
    Wrong,
}

/// What a keystroke did, so the sheet knows where the cursor goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Typed {
    /// Letters were added to this word.
    Letters,
    /// A space or other separator: on to the next word.
    Next,
    /// Nothing usable (a digit, an accent, or a letter past the longest word).
    Ignored,
}

pub fn status_of(word: &[u8]) -> WordStatus {
    if word.is_empty() {
        return WordStatus::Empty;
    }
    // ASCII only: anything else can't be on the English list.
    let Ok(w) = std::str::from_utf8(word) else {
        return WordStatus::Wrong;
    };
    let list = English::get_all();
    if list.binary_search(&w).is_ok() {
        WordStatus::Word
    } else if list.iter().any(|x| x.starts_with(w)) {
        WordStatus::Partial
    } else {
        WordStatus::Wrong
    }
}

struct Words {
    length: usize,
    words: Vec<Zeroizing<Vec<u8>>>,
}

impl Words {
    fn word(&mut self, index: u32) -> Option<&mut Zeroizing<Vec<u8>>> {
        let i = index as usize;
        if i < self.length {
            self.words.get_mut(i)
        } else {
            None
        }
    }

    /// The phrase as `custody` takes it, in a buffer that's wiped on drop.
    fn joined(&self) -> Zeroizing<Vec<u8>> {
        let mut out = Zeroizing::new(Vec::with_capacity(self.length * (LONGEST_WORD + 1)));
        for (i, w) in self.words[..self.length].iter().enumerate() {
            if i > 0 {
                out.push(b' ');
            }
            out.extend_from_slice(w);
        }
        out
    }
}

/// The phrase being typed into the native sheet. One per sheet; dropped when it closes.
#[derive(uniffi::Object)]
pub struct PhraseBuffer {
    inner: Mutex<Words>,
}

impl PhraseBuffer {
    fn with<T>(&self, f: impl FnOnce(&mut Words) -> T) -> T {
        // A poisoned lock still holds the words; using it keeps clear() working.
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g)
    }

    /// The phrase for signing, wiped when the caller drops it.
    pub(crate) fn phrase(&self) -> Zeroizing<Vec<u8>> {
        self.with(|w| w.joined())
    }
}

#[uniffi::export]
impl PhraseBuffer {
    /// An empty phrase of `length` words (24 if that isn't a BIP-39 length).
    #[uniffi::constructor]
    pub fn new(length: u32) -> Self {
        let max = *LENGTHS.last().unwrap() as usize;
        let words = (0..max)
            .map(|_| Zeroizing::new(Vec::with_capacity(LONGEST_WORD)))
            .collect();
        let b = PhraseBuffer {
            inner: Mutex::new(Words { length: max, words }),
        };
        b.set_length(length);
        b
    }

    pub fn length(&self) -> u32 {
        self.with(|w| w.length as u32)
    }

    /// Changes the number of words; words past the new length are wiped. False if it isn't a
    /// BIP-39 length.
    pub fn set_length(&self, length: u32) -> bool {
        if !LENGTHS.contains(&length) {
            return false;
        }
        self.with(|w| {
            w.length = length as usize;
            for word in &mut w.words[length as usize..] {
                word.zeroize();
            }
        });
        true
    }

    /// One keystroke (or a short burst) into word `index`. Letters are lowercased and added up
    /// to the longest word; a separator moves on. `input` is wiped once read.
    pub fn type_into(&self, index: u32, input: Vec<u8>) -> Typed {
        let input = Zeroizing::new(input);
        self.with(|w| {
            let Some(word) = w.word(index) else {
                return Typed::Ignored;
            };
            let mut typed = Typed::Ignored;
            for &b in input.iter() {
                if b.is_ascii_alphabetic() {
                    if word.len() < LONGEST_WORD {
                        word.push(b.to_ascii_lowercase());
                        typed = Typed::Letters;
                    }
                } else if b.is_ascii_whitespace() || b.is_ascii_punctuation() {
                    return Typed::Next;
                }
            }
            typed
        })
    }

    /// Deletes the last letter of word `index`; false if it was already empty.
    pub fn backspace(&self, index: u32) -> bool {
        self.with(|w| match w.word(index) {
            // Zero the letter in place first: pop only shortens the Vec, leaving the byte behind.
            Some(word) => match word.last_mut() {
                Some(last) => {
                    *last = 0;
                    word.pop();
                    true
                }
                None => false,
            },
            None => false,
        })
    }

    /// A pasted phrase, split on anything that isn't a letter. A whole phrase of a BIP-39
    /// length replaces everything and sets the length; otherwise the words fill from `index`.
    /// Returns the index after the last word filled. `input` is wiped once read.
    pub fn paste(&self, index: u32, input: Vec<u8>) -> u32 {
        let input = Zeroizing::new(input);
        let pasted: Vec<Zeroizing<Vec<u8>>> = input
            .split(|b| !b.is_ascii_alphabetic())
            .filter(|w| !w.is_empty())
            .map(|w| {
                Zeroizing::new(
                    w.iter()
                        .take(LONGEST_WORD)
                        .map(u8::to_ascii_lowercase)
                        .collect(),
                )
            })
            .collect();
        let n = pasted.len() as u32;
        let whole = LENGTHS.contains(&n);
        if whole {
            self.set_length(n);
        }
        self.with(|w| {
            let start = if whole || n as usize == w.length {
                0
            } else {
                index as usize
            };
            let mut at = start;
            for p in pasted {
                if at >= w.length {
                    break;
                }
                w.words[at].zeroize();
                w.words[at].extend_from_slice(&p);
                at += 1;
            }
            at as u32
        })
    }

    pub fn word_length(&self, index: u32) -> u32 {
        self.with(|w| w.word(index).map_or(0, |x| x.len() as u32))
    }

    pub fn word_status(&self, index: u32) -> WordStatus {
        self.with(|w| w.word(index).map_or(WordStatus::Empty, |x| status_of(x)))
    }

    /// Words that aren't empty.
    pub fn filled(&self) -> u32 {
        self.with(|w| w.words[..w.length].iter().filter(|x| !x.is_empty()).count() as u32)
    }

    /// Whether every word is on the list and the checksum holds.
    pub fn is_valid(&self) -> bool {
        let all_words = self.with(|w| {
            w.words[..w.length]
                .iter()
                .all(|x| status_of(x) == WordStatus::Word)
        });
        all_words && crate::custody::phrase_is_valid(&self.phrase())
    }

    /// Wipes every word.
    pub fn clear(&self) {
        self.with(|w| {
            for word in &mut w.words {
                word.zeroize();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &str = "test test test test test test test test test test test junk";

    fn typed(b: &PhraseBuffer, text: &str) {
        let mut i = 0;
        for c in text.bytes() {
            if b.type_into(i, vec![c]) == Typed::Next {
                i += 1;
            }
        }
    }

    #[test]
    fn marks_each_word_as_it_is_typed() {
        assert_eq!(status_of(b""), WordStatus::Empty);
        assert_eq!(status_of(b"zo"), WordStatus::Partial);
        assert_eq!(status_of(b"zoo"), WordStatus::Word);
        assert_eq!(status_of(b"act"), WordStatus::Word); // also starts "action"
        assert_eq!(status_of(b"qx"), WordStatus::Wrong);
        let list = English::get_all();
        assert_eq!(list.len(), 2048);
        // status_of binary-searches it.
        assert!(list.windows(2).all(|p| p[0] < p[1]));
    }

    #[test]
    fn takes_a_phrase_a_keystroke_at_a_time() {
        let b = PhraseBuffer::new(12);
        typed(&b, DEV);
        assert_eq!(b.filled(), 12);
        assert!(b.is_valid());
        assert_eq!(&*b.phrase(), DEV.as_bytes());
        // Fixing one word on its own.
        assert!(b.backspace(11));
        assert_eq!(b.word_status(11), WordStatus::Partial);
        assert!(!b.is_valid());
        assert_eq!(b.type_into(11, b"K".to_vec()), Typed::Letters);
        assert!(b.is_valid());
    }

    #[test]
    fn ignores_what_cannot_be_a_word_and_caps_its_length() {
        let b = PhraseBuffer::new(12);
        assert_eq!(b.type_into(0, b"1".to_vec()), Typed::Ignored);
        assert_eq!(b.type_into(0, "é".as_bytes().to_vec()), Typed::Ignored);
        assert_eq!(b.type_into(0, b"abcdefghij".to_vec()), Typed::Letters);
        assert_eq!(b.word_length(0), 8);
        assert_eq!(b.type_into(0, b"k".to_vec()), Typed::Ignored);
        assert_eq!(b.type_into(12, b"a".to_vec()), Typed::Ignored);
        assert!(!b.backspace(12));
    }

    #[test]
    fn a_pasted_phrase_sets_its_length_and_fills_from_the_start() {
        let b = PhraseBuffer::new(24);
        assert_eq!(
            b.paste(
                5,
                format!("  {}\n", DEV.replace(' ', "\u{a0} ")).into_bytes()
            ),
            12
        );
        assert_eq!(b.length(), 12);
        assert!(b.is_valid());
        // A few words fill from the box they're pasted into.
        let c = PhraseBuffer::new(24);
        assert_eq!(c.paste(3, b"zoo zoo".to_vec()), 5);
        assert_eq!(c.word_length(3), 3);
        assert_eq!(c.word_length(0), 0);
    }

    #[test]
    fn shortening_and_clearing_wipe_the_words() {
        let b = PhraseBuffer::new(24);
        b.paste(0, b"zoo ".repeat(24));
        assert!(b.set_length(12));
        assert!(!b.set_length(13));
        assert!(b.set_length(24));
        assert_eq!(b.word_length(12), 0);
        assert_eq!(b.filled(), 12);
        b.clear();
        assert_eq!(b.filled(), 0);
        assert!(b.phrase().iter().all(|&c| c == b' '));
    }
}
