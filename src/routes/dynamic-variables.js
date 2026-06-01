const express = require("express");
const dynamicVarsDb = require("../db/dynamic-variable-definitions");
const { authenticate } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

// GET /dynamic-variables — full catalog (read-only reference for the UI)
router.get("/", async (_req, res) => {
  try {
    const variables = await dynamicVarsDb.getAll();
    return res.json({ dynamic_variables: variables });
  } catch (err) {
    logger.error("GET /dynamic-variables failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load dynamic variables" });
  }
});

module.exports = router;
