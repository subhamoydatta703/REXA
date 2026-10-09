export class SecretScanner {
  // 1. Regular Expressions for common secret patterns
  private static readonly SCAN_PATTERNS: Record<string, RegExp> = {
    genericPassword: /(?:password|passwd|pwd|secret|pass_phrase|passphrase)(?:["'\s\w~!@#$%^&*()_+{}|:<>?-]*)(?:[:=]+)(?:\s*["']?)([A-Za-z0-9_.~!@#$%^&*()_+{}|:<>?-]{8,50})(?:\s*["']?)/gi,
    jwtToken: /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_+/=]+/g,
    stripeKey: /sk_(live|test)_[0-9a-zA-Z]{24}/g,
    awsKey: /AKIA[0-9A-Z]{16}/g,
    genericApiKey: /(?:api_key|apikey|token|auth_token)(?:\s*[:=]\s*["']?)([A-Za-z0-9-_]{16,64})(?:\s*["']?)/gi
  };

  // 2. Shannon Entropy calculation to catch random secret strings
  private static calculateEntropy(str: string): number {
    const len = str.length;
    if (len === 0) return 0;

    const frequencies: Record<string, number> = {};
    for (const char of str) {
      frequencies[char] = (frequencies[char] || 0) + 1;
    }

    return Object.values(frequencies).reduce((entropy, count) => {
      const p = count / len;
      return entropy - p * Math.log2(p);
    }, 0);
  }

  /**
   * Scans a given string for potential secrets.
   * Returns true if any secret pattern or high-entropy string is found.
   */
  public static containsSecret(input: string, entropyThreshold = 4.5): boolean {
    // Check regex patterns
    for (const pattern of Object.values(this.SCAN_PATTERNS)) {
      pattern.lastIndex = 0;
      if (pattern.test(input)) {
        return true;
      }
    }

    // Check individual words for high entropy (randomness)
    // A public URL's punctuation and path are not evidence of a credential.
    // Inspect its credential-bearing components instead of scoring the whole URL.
    let urlSecret = false;
    const withoutUrls = input.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw.replace(/[),.;\]}]+$/, ""));
        if (url.username || url.password) urlSecret = true;
        for (const [name, value] of [...url.searchParams, ...new URLSearchParams(url.hash.slice(1))]) {
          if (value && (/^(?:api[_-]?key|key|token|access[_-]?token|auth[_-]?token|password|passwd|secret|signature|sig|x-amz-signature)$/i.test(name) ||
              (value.length >= 16 && this.calculateEntropy(value) > entropyThreshold))) urlSecret = true;
        }
        return " ";
      } catch { return raw; }
    });
    if (urlSecret) return true;
    const words = withoutUrls.split(/[\s,;"']+/);
    for (const word of words) {
      if (word.length >= 16) {
        const entropy = this.calculateEntropy(word);
        if (entropy > entropyThreshold) {
          return true;
        }
      }
    }

    return false;
  }

  /** Redact detectable credentials before they reach terminal logs. */
  public static redact(input: string): string {
    let redacted = input.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = "REDACTED"; url.password = ""; }
        const fragment = new URLSearchParams(url.hash.slice(1));
        let fragmentRedacted = false;
        for (const [name, value] of fragment) {
          if (value && /^(?:api[_-]?key|key|token|access[_-]?token|auth[_-]?token|password|passwd|secret|signature|sig)$/i.test(name)) {
            fragment.set(name, "REDACTED"); fragmentRedacted = true;
          }
        }
        if (fragmentRedacted) url.hash = fragment.toString();
        for (const [name, value] of url.searchParams) {
          if (value && (/^(?:api[_-]?key|key|token|access[_-]?token|auth[_-]?token|password|passwd|secret|signature|sig|x-amz-signature)$/i.test(name) ||
              (value.length >= 16 && this.calculateEntropy(value) > 4.5))) url.searchParams.set(name, "REDACTED");
        }
        return url.href;
      } catch { return raw; }
    });
    for (const pattern of Object.values(this.SCAN_PATTERNS)) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return redacted.replace(/\b(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
  }
}
