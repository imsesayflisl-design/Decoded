// Rasterizes media/icon.svg into a 128x128 media/icon.png (the Marketplace tile).
// Run with: node scripts/build-icon.js
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const root = path.join(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "media", "icon.svg"));

const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 128 },
});
const png = resvg.render().asPng();
fs.writeFileSync(path.join(root, "media", "icon.png"), png);
console.log("Wrote media/icon.png (128x128)");
