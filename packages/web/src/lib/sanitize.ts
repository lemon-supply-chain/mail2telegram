import DOMPurify from 'dompurify';

export const EMAIL_LINK_MESSAGE_TYPE = 'mail2telegram:open-email-link';

/**
 * Sanitize an HTML email body before it is placed into a sandboxed iframe.
 * The iframe has no `allow-same-origin`, so it cannot access the app. Remove
 * email scripts and handlers before adding our own isolated link bridge.
 */
export function sanitizeEmailHtml(html: string): string {
    return DOMPurify.sanitize(html, {
        FORBID_TAGS: ['script', 'style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'link', 'meta'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'srcset'],
        ALLOW_DATA_ATTR: false,
    });
}

/** Wrap sanitized content in a minimal document with readable typography. */
export function buildEmailDocument(html: string, dark: boolean): string {
    const body = sanitizeEmailHtml(html);
    const nonce = crypto.randomUUID();
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  body {
    margin: 0; padding: 16px; background: transparent;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', Roboto, sans-serif;
    color: ${dark ? '#f5f5f5' : '#111'};
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: ${dark ? '#6ab2ff' : '#007aff'}; }
  pre { white-space: pre-wrap; }
</style></head><body>${body}
<script nonce="${nonce}">
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || link.hasAttribute('download')) return;
    if (link.getAttribute('href').startsWith('#')) {
      link.target = '_self';
      return;
    }
    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    event.preventDefault();
    // The sandbox has an opaque origin. Only the parent receives this message;
    // the parent validates the sending window before opening the URL.
    window.parent.postMessage({ type: '${EMAIL_LINK_MESSAGE_TYPE}', href: url.href }, '*');
  });
</script></body></html>`;
}
