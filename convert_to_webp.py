"""
Convert images (JPEG, PNG) to WEBP format.
Reads from TO_PROCESS folder, outputs to DONE folder.
"""

from pathlib import Path
from PIL import Image

# Folders
INPUT_FOLDER = Path("TO_PROCESS")
OUTPUT_FOLDER = Path("DONE")

# Supported extensions
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def convert_to_webp():
    # Create folders if they don't exist
    INPUT_FOLDER.mkdir(exist_ok=True)
    OUTPUT_FOLDER.mkdir(exist_ok=True)

    # Find all image files
    images = [f for f in INPUT_FOLDER.iterdir()
              if f.suffix.lower() in SUPPORTED_EXTENSIONS]

    if not images:
        print(f"No images found in {INPUT_FOLDER}/")
        return

    print(f"Found {len(images)} image(s) to convert\n")

    for image_path in images:
        output_path = OUTPUT_FOLDER / f"{image_path.stem}.webp"

        try:
            with Image.open(image_path) as img:
                # Convert to RGB if necessary (for PNG with transparency, use RGBA)
                if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                    img = img.convert("RGBA")
                else:
                    img = img.convert("RGB")

                img.save(output_path, "WEBP", quality=85)

                # Show size comparison
                original_size = image_path.stat().st_size / 1024
                new_size = output_path.stat().st_size / 1024
                savings = ((original_size - new_size) / original_size) * 100

                print(f"{image_path.name} -> {output_path.name}")
                print(f"  {original_size:.1f} KB -> {new_size:.1f} KB ({savings:.1f}% smaller)\n")

        except Exception as e:
            print(f"Error converting {image_path.name}: {e}\n")

    print("Done!")


if __name__ == "__main__":
    convert_to_webp()
