# Crypto tools

## `aes_inspect`

- group: `CRYPTO_SYMMETRIC`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ path?, text? }`

Guess AES mode from ciphertext layout (block alignment, ECB repetition). Does not decrypt.

**When to use**
- HEX blob or file that might be AES
- Looking for ECB vs CBC

**When not to use**
- Not a key-recovery tool

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| path | string | no | File of raw ciphertext. |
| text | string | no | HEX ciphertext. |

**Example**

```json
{
  "text": "00112233445566778899aabbccddeeff"
}
```

**Output**

likelyMode and notes.

## `analyze_rsa_instance`

- group: `CRYPTO_RSA`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ n?, e?, c?, text?, path? }`

Analyze an RSA instance (n,e,c) and list cheap attack candidates. Does not decrypt.

**When to use**
- You have n and e (and maybe c)
- Need to know which shipped attack to try

**When not to use**
- Do not start with LLL
- Not an attack itself

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| n | bigint-string | no | Modulus as a string. |
| e | bigint-string | no | Public exponent as a string. |
| c | bigint-string | no | Ciphertext as a string. |
| text | string | no | Optional text to parse extra values from. |
| path | string | no | Optional file to parse. |

**Example**

```json
{
  "n": "100070063",
  "e": "3",
  "c": "8"
}
```

**Output**

bitLength, checks, attackCandidates, plus next-tool hints.

## `crt`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ a, m, b, m2 }`

Chinese Remainder Theorem for exactly two congruences: x ≡ a (mod m), x ≡ b (mod m2). This implementation does not accept remainders[]/moduli[] arrays.

**When to use**
- Two congruences
- Håstad pieces
- RSA with known p,q residues

**When not to use**
- More than two congruences — use run_python
- Do not pass remainders/moduli arrays

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| a | bigint-string | yes | First remainder. x ≡ a (mod m). |
| m | bigint-string | yes | First modulus. |
| b | bigint-string | yes | Second remainder. x ≡ b (mod m2). |
| m2 | bigint-string | yes | Second modulus. |

**Example**

```json
{
  "a": "2",
  "m": "3",
  "b": "3",
  "m2": "5"
}
```

**Output**

x or null if inconsistent / not coprime in this helper.

## `discrete_log_if_small`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ g, h, m }`

Baby-step giant-step discrete log: find small x with g^x ≡ h (mod m).

**When to use**
- Small order / small x
- g,h,m given

**When not to use**
- Full-size DH
- x is huge

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| g | bigint-string | yes | Generator / base. |
| h | bigint-string | yes | Target, g^x mod m. |
| m | bigint-string | yes | Modulus. |

**Example**

```json
{
  "g": "2",
  "h": "14",
  "m": "101"
}
```

**Output**

x or null if not small.

## `extended_gcd`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ a, b }`

Extended gcd: g, x, y with a*x + b*y = g.

**When to use**
- Need Bézout coefficients
- Common-modulus internals

**When not to use**
- Plain gcd is enough if you only need the divisor

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| a | bigint-string | yes | First integer. |
| b | bigint-string | yes | Second integer. |

**Example**

```json
{
  "a": "30",
  "b": "12"
}
```

**Output**

g, x, y.

## `factor_integer`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ n }`

Factor a (small) integer with trial division / Pollard Rho. Not a general NFS.

**When to use**
- n has < ~80 bits
- analyze_rsa_instance listed FACTOR

**When not to use**
- 1024-bit contest n without extra structure

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| n | bigint-string | yes | Integer to factor. |

**Example**

```json
{
  "n": "221"
}
```

**Output**

Factor list.

## `frequency_analysis`

- group: `CRYPTO_XOR_CLASSICAL`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ text?, path? }`

Letter frequency / Caesar shift hint on text.

**When to use**
- Classical cipher / Caesar / monoalphabetic

**When not to use**
- Modern AES/RSA blobs

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| text | string | no | Ciphertext text. |
| path | string | no | File to read as text. |

**Example**

```json
{
  "text": "Wklv lv d iodj"
}
```

**Output**

likelyCaesar and frequencies.

## `gcd`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ a, b }`

Greatest common divisor of two integers a and b.

**When to use**
- Shared factors between moduli
- Any number-theory step

**When not to use**
- Not an RSA decrypt

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| a | bigint-string | yes | First integer. |
| b | bigint-string | yes | Second integer. |

**Example**

```json
{
  "a": "12",
  "b": "18"
}
```

**Output**

gcd as a string.

## `integer_root`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ c, e }`

Integer e-th root of c. Reports whether the root is exact.

**When to use**
- Need ∛c or k-th root
- small-e without modulus

**When not to use**
- Not a modular root

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| c | bigint-string | yes | Radicand. |
| e | bigint-string | yes | Root degree, e.g. "3". |

**Example**

```json
{
  "c": "27",
  "e": "3"
}
```

**Output**

root and exact flag.

## `lcg_recover`

- group: `CRYPTO_PRNG`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ samples }`

Recover LCG a,c from a sequence of samples (glibc-style, known modulus 2^32 by default).

**When to use**
- PRNG outputs listed
- Need next numbers

**When not to use**
- MT19937 / other PRNGs
- Fewer than 3 samples

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| samples | string | yes | Whitespace or comma separated integers. |

**Example**

```json
{
  "samples": "7 1664532 1013904246 42"
}
```

**Output**

a,c if recovered.

## `lll_reduce`

- group: `CRYPTO_ADVANCED_MATH`
- exposure: `DISCOVERABLE`
- cost: `EXPENSIVE`
- signature: `{ matrix }`

LLL-reduce an integer lattice basis. It only reduces the matrix — it does not automatically solve an arbitrary lattice CTF. You must construct the lattice.

**When to use**
- You already built an integer basis
- Coppersmith / knapsack / stereotyped RSA after you know the lattice

**When not to use**
- Do not dump a random matrix because the challenge is Crypto
- Not a substitute for Fermat/Wiener/small-e

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| matrix | string | yes | JSON integer matrix or whitespace rows. |

**Example**

```json
{
  "matrix": "[[1,1,1],[-1,0,2],[3,5,6]]"
}
```

**Output**

Reduced basis and backend (local / sage / fpylll).

## `mod_inverse`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ a, m }`

Modular inverse: find x with a*x ≡ 1 (mod m).

**When to use**
- Need a^{-1} mod m
- CRT / affine / RSA d pieces

**When not to use**
- gcd(a,m)≠1 — there is no inverse

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| a | bigint-string | yes | Value to invert. |
| m | bigint-string | yes | Modulus. |

**Example**

```json
{
  "a": "3",
  "m": "11"
}
```

**Output**

inverse or null.

## `parse_crypto_values`

- group: `CRYPTO_PARSE`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ text?, path? }`

Parse n/e/c/p/q and similar labels from challenge text. Does not attack.

**When to use**
- Challenge text or a file contains n = ..., e = ..., c = ...
- Before any RSA attack

**When not to use**
- Do not use this to decrypt
- Not a substitute for analyze_rsa_instance

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| text | string | no | Raw challenge text to parse. |
| path | string | no | File to read instead of text. |

**Example**

```json
{
  "text": "n=221 e=5 c=80"
}
```

**Output**

Map of parsed labels to integer strings.

## `rsa_basic_decrypt`

- group: `CRYPTO_RSA`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ n, c, e?, p?, q? }`

Decrypt textbook RSA if n factors or p,q are known.

**When to use**
- You have n,c and either factors or p,q
- After fermat/factor_integer

**When not to use**
- Do not call this hoping it will break strong RSA

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| n | bigint-string | yes | Modulus. |
| c | bigint-string | yes | Ciphertext. |
| e | bigint-string | no | Public exponent, default 65537. |
| p | bigint-string | no | Known prime factor. |
| q | bigint-string | no | Known prime factor. |

**Example**

```json
{
  "n": "221",
  "c": "80",
  "e": "5",
  "p": "13",
  "q": "17"
}
```

**Output**

m or null.

## `rsa_common_modulus`

- group: `CRYPTO_RSA`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ n, e1, c1, e2, c2 }`

Recover m when the same RSA modulus and the same plaintext were used with two different coprime public exponents.

**When to use**
- Two ciphertexts represent the same plaintext
- Both use the same modulus n
- Public exponents e1 and e2 are usually coprime

**When not to use**
- Different plaintexts
- Different moduli
- Only one ciphertext/exponent pair

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| n | bigint-string | yes | Shared RSA modulus. |
| e1 | bigint-string | yes | First public exponent. |
| c1 | bigint-string | yes | Ciphertext under e1. |
| e2 | bigint-string | yes | Second public exponent. |
| c2 | bigint-string | yes | Ciphertext under e2. |

**Example**

```json
{
  "n": "221",
  "e1": "3",
  "c1": "80",
  "e2": "5",
  "c2": "163"
}
```

**Output**

Recovered plaintext integer m or null.

## `rsa_fermat`

- group: `CRYPTO_RSA`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ n }`

Fermat factorization when p and q are very close. Input is only n.

**When to use**
- p ≈ q
- analyze_rsa_instance listed FERMAT
- n = p*q with close primes

**When not to use**
- Uniform random primes far apart
- You only have e,c
- Do not use as a general factorizer

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| n | bigint-string | yes | RSA modulus. |

**Example**

```json
{
  "n": "100160063"
}
```

**Output**

p and q if found.

## `rsa_hastad`

- group: `CRYPTO_RSA`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ e, n1, c1, n2, c2, n3, c3 }`

Håstad broadcast: same plaintext, same small e, different pairwise-coprime moduli. This implementation takes exactly 3 (n,c) pairs and e.

**When to use**
- Same plaintext encrypted to several recipients
- Same small e (typically 3)
- At least e pairwise-coprime moduli

**When not to use**
- Same modulus (use rsa_common_modulus)
- Different plaintexts
- Only one (n,c)

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| e | bigint-string | yes | Shared small exponent, usually "3". |
| n1 | bigint-string | yes | First modulus. |
| c1 | bigint-string | yes | First ciphertext. |
| n2 | bigint-string | yes | Second modulus. |
| c2 | bigint-string | yes | Second ciphertext. |
| n3 | bigint-string | yes | Third modulus. |
| c3 | bigint-string | yes | Third ciphertext. |

**Example**

```json
{
  "e": "3",
  "n1": "221",
  "c1": "8",
  "n2": "323",
  "c2": "8",
  "n3": "437",
  "c3": "8"
}
```

**Output**

m or null.

## `rsa_small_e`

- group: `CRYPTO_RSA`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ c, e, n? }`

Textbook RSA small-exponent attack: recover m from c = m^e (optionally mod n) when e is tiny (typically 3) and m^e has not wrapped, or by trying small k*n + c roots.

**When to use**
- e = 3 (or other tiny e)
- c may be a perfect e-th power
- analyze_rsa_instance listed SMALL_E

**When not to use**
- Ordinary e=65537
- No ciphertext
- You only have n

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| c | bigint-string | yes | Ciphertext integer string. |
| e | bigint-string | yes | Public exponent, typically "3". |
| n | bigint-string | no | Modulus. Omit when m^e < n (pure integer root). |

**Example**

```json
{
  "c": "27",
  "e": "3"
}
```

**Output**

Recovered plaintext integer m, or null.

## `rsa_wiener`

- group: `CRYPTO_RSA`
- exposure: `DISCOVERABLE`
- cost: `NORMAL`
- signature: `{ n, e }`

Wiener attack: recover small private exponent d from n,e.

**When to use**
- known n,e
- d suspected unusually small
- analyze_rsa_instance listed WIENER

**When not to use**
- Ordinary random RSA
- No n/e
- Only p,q close (use Fermat instead)

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| n | bigint-string | yes | Modulus. |
| e | bigint-string | yes | Public exponent (usually large when d is small). |

**Example**

```json
{
  "n": "2430101",
  "e": "17993"
}
```

**Output**

d or null.

## `solve_linear_congruence`

- group: `CRYPTO_NUMBER_THEORY`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ a, b, m }`

Solve ax ≡ b (mod m). Returns one particular solution and the reduced modulus.

**When to use**
- Linear congruence
- Affine cipher key recovery

**When not to use**
- Not a discrete log
- Not CRT

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| a | bigint-string | yes | Coefficient. |
| b | bigint-string | yes | Right-hand side. |
| m | bigint-string | yes | Modulus. |

**Example**

```json
{
  "a": "3",
  "b": "4",
  "m": "7"
}
```

**Output**

x and reduced modulus, or no solution.

## `xor_bytes`

- group: `CRYPTO_XOR_CLASSICAL`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ a, b?, key? }`

XOR hex data with a UTF-8 key. a is HEX ciphertext/data; b or key is a UTF-8 string (NOT hex).

**When to use**
- Single-byte or repeating-key XOR
- You already know the key as text

**When not to use**
- Do not pass b as hex unless the key really is those ASCII hex characters
- Not for AES

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| a | hex-string | yes | Data as hex (no 0x). |
| b | utf8-string | no | UTF-8 key. Repeats to the length of a. |
| key | utf8-string | no | Alias for b. |

**Example**

```json
{
  "a": "000000",
  "key": "A"
}
```

**Output**

XOR result as hex.

## `xor_known_plaintext`

- group: `CRYPTO_XOR_CLASSICAL`
- exposure: `DISCOVERABLE`
- cost: `CHEAP`
- signature: `{ c, p?, m? }`

Recover a keystream by XORing HEX ciphertext with a UTF-8 known plaintext prefix (often flag{).

**When to use**
- You know the first bytes (flag{)
- Many-time pad

**When not to use**
- No known plaintext

**Parameters**

| name | type | required | description |
| --- | --- | --- | --- |
| c | hex-string | yes | Ciphertext hex. |
| p | utf8-string | no | Known plaintext UTF-8. |
| m | utf8-string | no | Alias for p. |

**Example**

```json
{
  "c": "0000000000",
  "p": "flag{"
}
```

**Output**

Keystream hex of length min(c,p).
