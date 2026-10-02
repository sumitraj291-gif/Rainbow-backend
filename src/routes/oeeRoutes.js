const express = require("express");

const {
    getOEEOptions,
    getOEEReport
} = require("../controllers/oeeController");

const router = express.Router();

router.get("/options", getOEEOptions);
router.get("/", getOEEReport);

module.exports = router;
