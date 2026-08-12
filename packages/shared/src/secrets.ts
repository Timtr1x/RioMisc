// SecretStore: AES-256-GCM encrypted secrets file.
// Database only stores `apiKeyRef`; the master key comes from CTF_RUNTIME_MASTER_KEY.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  hasMasterKey(): boolean;
}

const MAGIC = "RIOSEC1";

function deriveKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey).digest();
}

export class FileSecretStore implements SecretStore {
  private readonly filePath: string;
  private readonly key: Buffer | null;
  private readonly secrets = new Map<string, string>();

  constructor(filePath: string, masterKey: string | undefined) {
    this.filePath = filePath;
    this.key = masterKey && masterKey.length > 0 ? deriveKey(masterKey) : null;
    if (this.key && existsSync(filePath)) this.#load();
  }

  hasMasterKey(): boolean {
    return this.key !== null;
  }

  #load() {
    const raw = readFileSync(this.filePath, "utf8").trim();
    if (!raw) return;
    const [magic, ivHex, dataHex] = raw.split(":");
    if (magic !== MAGIC || !ivHex || !dataHex) throw new Error("Corrupted secrets file");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", this.key!, iv);
    // tag = last 16 bytes of dataHex
    const data = Buffer.from(dataHex, "hex");
    const tag = data.subarray(data.length - 16);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    const parsed = JSON.parse(plain.toString("utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) this.secrets.set(k, v);
  }

  #persist() {
    if (!this.key) throw new Error("SecretStore has no master key (set CTF_RUNTIME_MASTER_KEY)");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plain = Buffer.from(JSON.stringify(Object.fromEntries(this.secrets)), "utf8");
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${MAGIC}:${iv.toString("hex")}:${Buffer.concat([enc, tag]).toString("hex")}`, { mode: 0o600 });
  }

  async get(ref: string): Promise<string | null> {
    return this.secrets.get(ref) ?? null;
  }

  async set(ref: string, value: string): Promise<void> {
    if (!this.key) throw new Error("SecretStore has no master key (set CTF_RUNTIME_MASTER_KEY)");
    this.secrets.set(ref, value);
    this.#persist();
  }

  async delete(ref: string): Promise<void> {
    this.secrets.delete(ref);
    this.#persist();
  }

  /** Constant-time check helper for comparing stored secrets (used by tests). */
  static matches(a: string, b: string): boolean {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
  }
}
