import { createHash } from "node:crypto";
export function observationContent(input: {
  text: string;
  sourceLength: number;
  structured: string[];
}) {
  const products: { name: string; price: number; currency: string }[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8 || products.length >= 20 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) visit(item, depth + 1);
      return;
    }
    const item = value as Record<string, unknown>;
    if (item["@type"] === "Product" && typeof item.name === "string") {
      const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
      for (const raw of offers.slice(0, 20)) {
        if (!raw || typeof raw !== "object") continue;
        const offer = raw as Record<string, unknown>,
          price = Number(offer.price);
        if (
          offer["@type"] === "Offer" &&
          (typeof offer.price === "string" || typeof offer.price === "number") &&
          Number.isFinite(price) &&
          price > 0 &&
          typeof offer.priceCurrency === "string" &&
          /^[A-Z]{3}$/.test(offer.priceCurrency)
        )
          products.push({ name: item.name.slice(0, 300), price, currency: offer.priceCurrency });
      }
    }
    if (item["@graph"]) visit(item["@graph"], depth + 1);
  };
  for (const raw of input.structured.slice(0, 20)) {
    try {
      visit(JSON.parse(raw));
    } catch {
      /* Malformed page data is not a connector failure. */
    }
  }
  const complete = input.sourceLength === input.text.length;
  return {
    text: input.text.slice(0, 100_000),
    truncated: input.sourceLength > 100_000,
    contentHash: complete
      ? createHash("sha256").update(input.text.replace(/\s+/g, " ").trim()).digest("hex")
      : undefined,
    sourceLength: input.sourceLength,
    products,
  };
}
