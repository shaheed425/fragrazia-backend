const parseMl = (sizeStr) => {
  if (typeof sizeStr !== "string") return null;
  const match = sizeStr.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) && num > 0 ? num : null;
};

const roundScaledAmount = (value) => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 100 ? Math.round(value / 10) * 10 : Math.max(1, Math.round(value));
};

/**
 * Compute size-adjusted MRP, sale price, effective unit price, and discount %
 * relative to product.sizes[0] so storefront card base prices remain exact.
 */
const getSizePricing = (product, size) => {
  if (!product) {
    return { price: 0, saleprice: 0, effectivePrice: 0, discountPercent: 0, size: "" };
  }

  const basePrice = Number(product.price) || 0;
  const rawSale = Number(product.saleprice) || 0;
  const hasBaseDiscount = rawSale > 0 && rawSale < basePrice;

  const baseSize = Array.isArray(product.sizes) && product.sizes.length > 0 ? String(product.sizes[0]) : "";
  const activeSize = typeof size === "string" && size.trim() ? size.trim() : baseSize;

  const baseMl = parseMl(baseSize);
  const targetMl = parseMl(activeSize);

  let price = basePrice;
  let saleprice = hasBaseDiscount ? rawSale : 0;

  if (baseMl && targetMl && activeSize !== baseSize) {
    const factor = Math.pow(targetMl / baseMl, 0.8);
    price = roundScaledAmount(basePrice * factor);
    if (hasBaseDiscount) {
      const scaledSale = roundScaledAmount(rawSale * factor);
      saleprice = scaledSale >= price ? Math.max(1, price - 1) : scaledSale;
    }
  }

  const hasDiscount = saleprice > 0 && saleprice < price;
  const effectivePrice = hasDiscount ? saleprice : price;
  const discountPercent =
    hasDiscount && price > 0 ? Math.round(((price - saleprice) / price) * 100) : 0;

  return {
    price,
    saleprice,
    effectivePrice,
    discountPercent,
    size: activeSize,
  };
};

module.exports = { parseMl, getSizePricing };

