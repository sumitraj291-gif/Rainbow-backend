const express = require("express");
const router = express.Router();
const rawMaterialController = require("../controllers/rawMaterialController");

// Stats
router.get("/stats", rawMaterialController.getInventoryStats);

// Materials List
router.get("/", rawMaterialController.getRawMaterials);

// Formulations / Recipes
router.get("/formulations", rawMaterialController.getFormulations);

// Paste Mixing Batches
router.get("/mixing-batches", rawMaterialController.getMixingBatches);
router.post("/mixing-batches", rawMaterialController.createMixingBatch);
router.put("/mixing-batches/:id/issue", rawMaterialController.issueBatchToLine);

// Seed sample batches
router.post("/seed", rawMaterialController.seedRawMaterials);

module.exports = router;
