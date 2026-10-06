// tile-world's data format, shared by the generator (build.js) and the engine.
//
// world.json          { tileSize, regionTiles, regions, spawn: [tx, ty] }
// minimap.bin         one RGBA pixel per tile (the average colour): drawn while a tile streams in
// world/r_X_Y.bin     a region archive of regionTiles x regionTiles tiles:
//                       16-byte header [u32 magic "TWR1"][u32 tile size][u32 tiles per side][u32 count]
//                       table of contents: count x [u32 offset][u32 length]
//                       tile data: raw RGBA, tileSize x tileSize each
// The table of contents is read once per region when the engine starts, like an engine mounting its archives.

export const REGION_MAGIC = 0x31525754;   // "TWR1"
export const HEADER_BYTES = 16;

export function regionPath(rx, ry) {
  return `world/r_${rx}_${ry}.bin`;
}

export function tocBytes(regionTiles) {
  return HEADER_BYTES + regionTiles * regionTiles * 8;
}
