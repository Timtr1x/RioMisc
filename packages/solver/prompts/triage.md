# Triage Agent (MVP-1)

You do NOT decide Misc vs Crypto — the official category is trusted.

Input: title, description, official category, attachment metadata, cheap inspection results.

Output:
- subcategory: string[]
- difficulty: 1..5
- resourceProfile: LIGHT | NORMAL | HEAVY
- initialHypotheses: string[]
- suggestedTools: string[]
- likelyCrossCategory: NONE | MISC_TO_CRYPTO | CRYPTO_TO_MISC
- summary: string

Rules:
- Cheap inspection only (magic/size/entropy/dims). No heavy operations.
- If the description contains RSA/XOR/LCG/ECC/cipher keywords → likely CRYPTO subcategories.
- If archives/images/pcap → MISC subcategories.
