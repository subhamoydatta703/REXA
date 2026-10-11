import { SecretScanner } from "../guardrails/types/SecretScanner";

/** Preserve provider signatures, but exclude credentials and inline binary payloads. */
export function sanitizeStored<T>(value: T): T {
    const credentials = Object.entries(process.env)
        .filter(
            ([key, val]) =>
                /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key) &&
                val &&
                val.length >= 4,
        )
        .map(([, val]) => val!);
    const sanitizeValue = (value: unknown, key = ""): unknown => {
        if (key === "thoughtSignature" || key === "thought_signature") {
            return value;
        }
        if (
            /^(?:api[_-]?key|authorization|password|access[_-]?token|auth[_-]?token|secret|inlineData)$/i.test(
                key,
            )
        ) {
            return "[REDACTED]";
        }
        if (typeof value === "string") {
            let sanitized = value;
            for (const credential of credentials) {
                sanitized = sanitized.split(credential).join("[REDACTED]");
            }
            return SecretScanner.redact(sanitized);
        }
        if (Array.isArray(value)) {
            return value.map((item) => sanitizeValue(item));
        }
        if (value && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value).map(([fieldName, item]) => [
                    fieldName,
                    sanitizeValue(item, fieldName),
                ]),
            );
        }
        return value;
    };
    return sanitizeValue(value) as T;
}
