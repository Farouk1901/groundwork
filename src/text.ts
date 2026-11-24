// Text preparation shared by Node.js and the browser.

/** Plain text for embedding and search: title first, then the body without code blocks, HTML or long URLs. */
export function cleanText(title: string, body = '', max = 1200): string {
  const b = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${title.trim()}. ${b}`.slice(0, max);
}
