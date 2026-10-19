/** Limits apply before decoding, redaction, persistence, or diagnostic classification. */
export const MAX_LOG_BYTES = 128 * 1024;
export const MAX_LOG_EXCERPT = 16 * 1024;

export function redactLog(input: string, secrets: readonly string[] = []): string {
  let text = input;
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(
      /(["'])((?:set-)?cookie[ \t]*:[ \t]*)(?:\\.|(?!\1)[^\\\r\n])*(?:\1|(?=\r?\n|$))|(\b(?:set-)?cookie\b["'][ \t]*[:=][ \t]*)(?:(["'])(?:\\.|(?!\4)[^\\\r\n])*(?:\4|(?=\r?\n|$))|[^\r\n]*)|(\b(?:set-)?cookie\b[ \t]*[:=][ \t]*)[^\r\n]*/gi,
      (
        _match,
        headerQuote: string | undefined,
        header: string | undefined,
        prefix: string | undefined,
        valueQuote: string | undefined,
        rawPrefix: string | undefined,
      ) =>
        headerQuote
          ? `${headerQuote}${header}[REDACTED COOKIE]${headerQuote}`
          : `${prefix ?? rawPrefix}${valueQuote ?? ''}[REDACTED COOKIE]${valueQuote ?? ''}`,
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g,
      '[REDACTED TOKEN]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED TOKEN]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '[REDACTED AUTHORIZATION]')
    .replace(
      /(\bauthorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\r\n]*)/gi,
      '$1[REDACTED AUTHORIZATION]',
    )
    .replace(
      /(\b(?:[A-Za-z][A-Za-z0-9_]*_)?(?:token|api[_-]?key|secret|password|passwd|client[_-]?secret|access[_-]?token|authorization|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s,;&]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:sig|signature|access_token|token|key|credential|x-amz-[a-z-]+)=)[^&\s]+/gi,
      '$1[REDACTED]',
    );
}

/** Signed download URLs are never persisted and never receive an Authorization header. */
export function isAllowedLogUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      (/^productionresultssa[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
        /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

export async function readBoundedText(
  response: Response,
  maximum = MAX_LOG_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new Error('GitHub response exceeds download size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw new Error('GitHub response exceeds download size limit');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Redact the entire bounded download before selecting the failure-prone tail. */
export function logExcerpt(input: string, secrets: readonly string[] = []): string {
  const bytes = Buffer.from(redactLog(input, secrets));
  let start = Math.max(0, bytes.length - MAX_LOG_EXCERPT);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}
