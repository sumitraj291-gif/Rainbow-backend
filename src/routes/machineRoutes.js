const express = require("express");

const {
    getMachines,
    getMachineById,
    getMachineOptions,
    createMachine,
    updateMachine,
    updateMachineStatus,
    deleteMachine
} = require("../controllers/machineController");

const router = express.Router();

router.get("/", getMachines);

router.get("/options", getMachineOptions);

router.get("/:id", getMachineById);

router.post("/", createMachine);

router.put("/:id", updateMachine);

router.patch("/:id/status", updateMachineStatus);

router.delete("/:id", deleteMachine);

module.exports = router;