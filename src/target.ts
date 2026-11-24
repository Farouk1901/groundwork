/** "1234" or "#1234" is a GitHub ticket, "SHOP-142" a Jira key; anything else describes the change. */
export const targetOf = (what: string): { issue: number | string } | { text: string } =>
  /^#?\d+$/.test(what.trim()) ? { issue: Number(what.trim().replace('#', '')) }
    : /^[A-Z][A-Z0-9]+-\d+$/.test(what.trim()) ? { issue: what.trim() } : { text: what.slice(0, 2000) };
