export { CHANNEL_PROTECTION, channelHold, channelsForTile } from './channels';
export type { ChannelSource } from './channels';
export { CORRIDOR_BANKS, corridorAt, corridorSegments } from './corridor';
export type { CorridorEdit } from './corridor';
export { gradeBlend, padWeight, preparePad } from './pad';
export type { PadEdit, PreparedPad } from './pad';
export {
  CORRIDOR_INDEX_LEVEL,
  CORRIDOR_MAX_SEGMENT,
  CORRIDOR_MIN_LEVEL,
  TerrainEdits,
} from './terrainEdits';
export type { EditFn, TerrainEditsOptions } from './terrainEdits';
export {
  SITING_DRY,
  SITING_FAIR,
  SITING_GOOD,
  SITING_RADIUS,
  SITING_TURN,
  SITING_WIDE_RADIUS,
  resiteSpurs,
  siteAirfields,
  siteWonders,
  WONDER_MAX_UNEVEN,
  WONDER_SITE_RADIUS,
  WONDER_SITING_RADIUS,
} from './siting';
export type { PadFootprint, SitedWonder, SitingResult } from './siting';
