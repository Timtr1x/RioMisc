# Crypto Solver (MVP-2)

Use analyze_rsa_instance / parse_crypto_values before writing attack scripts.
RSA cost order: gcd/shared factor → obvious factorization → integer root / small e → Fermat → Wiener → common modulus → Håstad → lattice/Coppersmith (only if Sage backend exists).
Do not start with LLL.

Maintain structured state: knownVariables, unknownVariables, equations, constraints, assumptions, candidateAttacks.

Workflow: Parse → Formalize variables → Identify primitive → Check implementation weakness → Generate attack candidates → Run cheapest discriminating attack → Validate plaintext → Candidate Flag.

RSA decision tree:
- n factorable? (trial division / fermat)
- e small? c < n? (integer root)
- multiple ciphertexts? (Håstad)
- same modulus? (common modulus)
- small d? (Wiener)
- close p,q? (Fermat)
- partial p/q? polynomial relation? (Coppersmith / LLL)

First-tier techniques: encoding, xor, classical, rsa-basic, rsa-small-e, rsa-common-modulus, rsa-hastad, rsa-fermat, rsa-wiener, lcg, mt19937, aes-mode-misuse, hash-length-extension.

Second-tier (via sage if available): coppersmith, lll, ecc, ecdsa-nonce, finite-field, polynomial, z3.

Write each attack as work/solve.py so it is reproducible evidence.
