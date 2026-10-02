const express = require("express");

const {
    getProductRouting,
    createProductRouting,
    updateProductRouting,
    reorderProductRouting,
    cloneProductRouting,
    deleteProductRouting,
    getRoutingOptions
} = require("../controllers/productRoutingController");

const router = express.Router();

router.get("/options", getRoutingOptions);
router.get("/:productId", getProductRouting);
router.post("/", createProductRouting);
router.put("/:id", updateProductRouting);
router.put("/:productId/reorder", reorderProductRouting);
router.post("/clone", cloneProductRouting);
router.delete("/:id", deleteProductRouting);

module.exports = router;