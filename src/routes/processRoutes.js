const express = require("express");

const {
    getProcesses,
    getProcessOptions,
    createProcess,
    updateProcess,
    deleteProcess
} = require("../controllers/processController");

const router = express.Router();

router.get("/", getProcesses);
router.get("/options", getProcessOptions);
router.post("/", createProcess);
router.put("/:id", updateProcess);
router.delete("/:id", deleteProcess);

module.exports = router;
