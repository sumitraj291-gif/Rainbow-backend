const express = require("express");
const router = express.Router();
const dispatchController = require("../controllers/dispatchChallanController");

// Stats & Ready Rolls
router.get("/stats", dispatchController.getChallanStats);
router.get("/ready-rolls", dispatchController.getReadyRolls);

// List & Detail
router.get("/", dispatchController.getChallans);
router.get("/:id", dispatchController.getChallanById);

// Create & Lifecycle
router.post("/", dispatchController.createChallan);
router.put("/:id/confirm-dispatch", dispatchController.confirmDispatch);
router.put("/:id/cancel", dispatchController.cancelChallan);

module.exports = router;
