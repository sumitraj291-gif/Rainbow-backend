const express = require("express");
const router = express.Router();
const rawMaterialController = require("../controllers/rawMaterialController");

// Stats
router.get("/stats", rawMaterialController.getInventoryStats);

// Metadata (Categories & Units for Dropdowns)
router.get("/metadata", rawMaterialController.getMetadata);

// Materials List & Create
router.get("/", rawMaterialController.getRawMaterials);
router.post("/", rawMaterialController.createRawMaterial);
router.put("/:id", rawMaterialController.updateRawMaterial);
router.delete("/:id", rawMaterialController.deleteRawMaterial);

// Stock Adjustments (+Add / -Deduct)
router.post("/:id/adjust-stock", rawMaterialController.adjustStock);

// Formulations / Recipes
router.get("/formulations", rawMaterialController.getFormulations);

// Paste Mixing Batches
router.get("/mixing-batches", rawMaterialController.getMixingBatches);
router.post("/mixing-batches", rawMaterialController.createMixingBatch);
router.put("/mixing-batches/:id/issue", rawMaterialController.issueBatchToLine);

// Seed sample batches
router.post("/seed", rawMaterialController.seedRawMaterials);

module.exports = router;
