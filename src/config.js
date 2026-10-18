const base = import.meta.env.BASE_URL;

export const SCHOOL_NAME = '흑석고등학교';
export const MODEL_URL = base + 'models/heukseok.glb';
export const GEOREF_URL = base + 'georef.json';

// Blender objects that form the ground surface. The GPS marker is dropped onto these
// (and never onto a roof), so a person inside a building still appears at ground level.
export const GROUND_OBJECTS = ['g', 'road.002', 'send', 'Plane'];

// Materials in the school model that are window glass. The model's own values (IOR 16, 69 % metallic,
// lost textures) render as white walls or flat blue panels, so the viewer swaps in a reflective glass.
export const GLASS_MATERIALS = ['Aluminum nitride (AlN).004', 'glass'];

// Beyond this distance from the school the GPS marker is hidden instead of drawn far off the map.
export const MAX_MARKER_DISTANCE_M = 1500;

// When an admin adds a plant, the spot must be within this distance of where they stand.
export const PLANT_PLACE_RADIUS_M = 30;

export const STORAGE_KEYS = {
  georef: 'biomemap.georef',
  calibrationPoints: 'biomemap.calibrationPoints',
};
