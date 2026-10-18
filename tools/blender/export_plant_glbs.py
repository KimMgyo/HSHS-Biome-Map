"""Export the three plant models from assets/blender/plants_lowpoly.blend to public/models/plants/.

Use this after editing the plants in Blender and saving the .blend:

    blender -b assets/blender/plants_lowpoly.blend --python tools/blender/export_plant_glbs.py

Each plant is exported on its own with its object location moved to the origin, so the GLB
origin is the point the web map puts on the ground. The .blend file is not saved.
"""
import os

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GLB_DIR = os.path.join(ROOT, "public", "models", "plants")
PLANTS = {"Tree_Large": "tree_large.glb", "Tree_Medium": "tree_medium.glb", "Grass_Small": "grass_small.glb"}

os.makedirs(GLB_DIR, exist_ok=True)
scene = bpy.context.scene
for name, fname in PLANTS.items():
    obj = bpy.data.objects[name]
    corners = [Vector(c) for c in obj.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    keep = obj.location.copy()
    obj.location = (0, 0, 0)
    for o in scene.objects:
        o.select_set(o == obj)
    bpy.context.view_layer.update()
    path = os.path.join(GLB_DIR, fname)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_extras=True, export_cameras=False, export_lights=False,
        export_image_format="NONE", export_animations=False)
    obj.location = keep
    print("PLANT_GLB", name, os.path.getsize(path), "local_min", [round(v, 3) for v in lo], "local_max", [round(v, 3) for v in hi])
