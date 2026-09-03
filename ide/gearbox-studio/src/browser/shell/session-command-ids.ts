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

export const SWITCH_PRODUCT = {
  id: "gearbox.product.switch",
  label: "Gearbox: Switch Product…",
  shortTitle: "Switch",
};

export const CLOSE_PRODUCT = {
  id: "gearbox.product.close",
  label: "Gearbox: Close Product",
  shortTitle: "Close",
};

export const NEW_GEAR = {
  id: "gearbox.gear.new",
  label: "Gearbox: New Gear",
};

export const OPEN_GEAR = {
  id: "gearbox.gear.open",
  label: "Gearbox: Open Gear…",
};

export const CLOSE_GEAR = {
  id: "gearbox.gear.close",
  label: "Gearbox: Close Gear",
  shortTitle: "Close",
};

export const ADD_GEAR = {
  id: "gearbox.product.addGear",
  label: "Gearbox: Add Gear…",
  shortTitle: "Add Gear",
};

export const BROWSE_CATALOGUE = {
  id: "gearbox.catalogue.browse",
  label: "Gearbox: Browse Catalogue",
  shortTitle: "Browse Catalogue",
};
