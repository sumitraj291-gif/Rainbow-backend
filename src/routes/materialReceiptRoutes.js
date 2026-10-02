const express = require("express");
const router = express.Router();
const materialReceiptController = require("../controllers/materialReceiptController");

// Stats & Suppliers
router.get("/stats", materialReceiptController.getReceiptStats);
router.get("/suppliers", materialReceiptController.getSuppliers);

// GRN List & Details
router.get("/", materialReceiptController.getReceipts);
router.get("/:id", materialReceiptController.getReceiptById);

// Create GRN
router.post("/", materialReceiptController.createReceipt);

module.exports = router;
