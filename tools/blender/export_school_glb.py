"""Export the visible part of the school model as a web-ready GLB.

Run it in either of these ways:

* Inside a running Blender, through the official Blender MCP "execute_blender_code"
  tool or Blender's Text Editor. The GLB goes to DEFAULT_OUT.
* From a terminal:
  blender -b 흑석고.blend --python tools/blender/export_school_glb.py -- public/models/heukseok.glb

Only visible objects are exported, modifiers are applied, and textures are skipped
because the source file references images that are no longer on disk.
"""
import os
import sys

import bpy

DEFAULT_OUT = r"D:\Users\G433m\Documents\biomemap\public\models\heukseok.glb"

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = os.path.abspath(argv[0]) if argv else DEFAULT_OUT
os.makedirs(os.path.dirname(out), exist_ok=True)

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    use_visible=True,
    export_apply=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
    export_extras=True,
    export_image_format="NONE",
    export_animations=False,
)
print("exported", out, os.path.getsize(out), "bytes")
