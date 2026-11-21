/** Returns immutable total COGS for a saved sale line.
 * Never falls back to the current product cost: that would rewrite historical profit.
 */
export function getImmutableSaleLineCostTotal(item) {
  const quantity = Number(item?.quantity || 0);
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  const snapshot = item?.costPriceAtTimeOfSale;
  if (snapshot !== undefined && snapshot !== null && Number.isFinite(Number(snapshot)) && Number(snapshot) >= 0) {
    return Number(snapshot) * quantity;
  }
  if (!item?.batchAllocations) return null;
  try {
    const allocations = typeof item.batchAllocations === 'string'
      ? JSON.parse(item.batchAllocations)
      : item.batchAllocations;
    if (Array.isArray(allocations)) {
      if (allocations.length === 0) return item?.itemType === 'service' ? 0 : null;
      const allocatedQuantity = allocations.reduce((sum, allocation) => sum + Math.max(0, Number(allocation.quantity || 0)), 0);
      const expectedBaseQuantity = quantity * Math.max(0, Number(item?.conversionFactor || 1));
      if (expectedBaseQuantity > 0 && allocatedQuantity + 1e-6 < expectedBaseQuantity) return null;
      return allocations.reduce((sum, allocation) => (
        sum + Math.max(0, Number(allocation.quantity || 0)) * Math.max(0, Number(allocation.costPrice || 0))
      ), 0);
    }
    if (allocations?.kind === 'service') return 0;
    if (allocations?.kind === 'recipe' && Array.isArray(allocations.ingredients)) {
      let total = 0;
      for (const ingredient of allocations.ingredients) {
        const ingredientAllocations = Array.isArray(ingredient.allocations) ? ingredient.allocations : [];
        const expectedIngredientQuantity = Math.max(0, Number(ingredient.quantityConsumed || 0));
        const allocatedIngredientQuantity = ingredientAllocations.reduce((part, allocation) => part + Math.max(0, Number(allocation.quantity || 0)), 0);
        if (expectedIngredientQuantity > 0 && allocatedIngredientQuantity + 1e-6 < expectedIngredientQuantity) return null;
        total += ingredientAllocations.reduce((part, allocation) => (
          part + Math.max(0, Number(allocation.quantity || 0)) * Math.max(0, Number(allocation.costPrice || 0))
        ), 0);
      }
      return total;
    }
  } catch {
    return null;
  }
  return null;
}
