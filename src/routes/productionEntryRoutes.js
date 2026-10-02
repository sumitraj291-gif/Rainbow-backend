const express = require("express");

const {
    getProductionEntries,
    getProductionEntryById,
    getProductionEntryOptions,
    createProductionEntry,
    updateProductionEntry,
    deleteProductionEntry,
    seedProductionEntries
} = require("../controllers/productionEntryController");

const router = express.Router();

router.get("/", getProductionEntries);

router.post("/seed", seedProductionEntries);

router.get(
    "/options",
    getProductionEntryOptions
);

router.get(
    "/:id",
    getProductionEntryById
);

router.post(
    "/",
    createProductionEntry
);

router.put(
    "/:id",
    updateProductionEntry
);

router.delete(
    "/:id",
    deleteProductionEntry
);

module.exports = router;