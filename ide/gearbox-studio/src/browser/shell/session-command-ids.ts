// Command ids shared without pulling in contributions — breaks the cycle
// StartWidget → session-commands → CreateProductViewContribution → StartWidget.

export const NEW_PRODUCT = {
  id: "gearbox.product.new",
  label: "Gearbox: New Product…",
};

export const OPEN_PRODUCT = {
  id: "gearbox.product.open",
  label: "Gearbox: Open Product…",
};

export const CLOSE_PRODUCT = {
  id: "gearbox.product.close",
  label: "Gearbox: Close Product",
};
