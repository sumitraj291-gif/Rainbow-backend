const express = require("express");
const {
    getCarpetRolls,
    getCarpetRollById,
    createCarpetRoll,
    bulkCreateCarpetRolls,
    updateCarpetRoll,
    deleteCarpetRoll,
    getCarpetRollStats,
    scanRoll,
    quickUpdateRoll
} = require("../controllers/carpetRollController");

const router = express.Router();

// Stats summary
router.get("/stats", getCarpetRollStats);

// Barcode / Serial Scan Lookup
router.get("/scan/:code", scanRoll);

// Quick status & bay update
router.patch("/:id/quick-update", quickUpdateRoll);

// List all rolls with filters & search
router.get("/", getCarpetRolls);

// Single roll details
router.get("/:id", getCarpetRollById);

// Create single roll
router.post("/", createCarpetRoll);

// Bulk generate rolls
router.post("/bulk", bulkCreateCarpetRolls);

// Update roll
router.put("/:id", updateCarpetRoll);

// Delete roll
router.delete("/:id", deleteCarpetRoll);

module.exports = router;
