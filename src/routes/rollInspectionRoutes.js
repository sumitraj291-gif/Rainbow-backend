const express = require("express");
const {
    getInspections,
    getInspectionById,
    getRollForInspection,
    createInspection,
    getQCStats
} = require("../controllers/rollInspectionController");

const router = express.Router();

// QC KPI Stats
router.get("/stats", getQCStats);

// Get roll pre-fill by roll_number or id
router.get("/roll/:code", getRollForInspection);

// List inspections
router.get("/", getInspections);

// Get single inspection & COA certificate
router.get("/:id", getInspectionById);

// Submit new lab inspection
router.post("/", createInspection);

module.exports = router;
