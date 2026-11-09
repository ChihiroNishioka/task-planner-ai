# 合成 HEIC 素材

64×40px の四隅を赤・緑・青・黄に塗った合成画像です。実写真・実座標・個人情報は含みません。各ファイルは 50KB 未満です。

- `synthetic-plain.heic`: 向き変更なし。
- `synthetic-gps.heic`: EXIF ImageDescription に GPS 除去確認用の `SYNTHETIC-GPS-SENTINEL`。実座標はありません。
- `synthetic-irot.heic`: Orientation=8 をエンコーダに指定し、HEIF の `irot` を生成。左へ90度回転後の左上は緑。
- `synthetic-imir.heic`: Orientation=2 を指定し、`imir` を生成。左右反転後の左上は緑。

生成環境は Pillow と pillow-heif 1.8.1（BSD-3-Clause、libheif は LGPL-3.0）。再生成は `/workspace/dev/tp-image-runs/.venv-heif/bin/python` で次のコードを実行します。生成には HEVC エンコーダも使われます。素材は検証用の社内利用です。

```python
from PIL import Image
import pillow_heif
from pathlib import Path
pillow_heif.register_heif_opener()
out = Path('tests/fixtures/images')
im = Image.new('RGB', (64, 40))
for y in range(40):
    for x in range(64):
        color = ((240, 20, 20) if x < 32 else (20, 220, 20)) if y < 20 else ((20, 20, 240) if x < 32 else (240, 220, 20))
        im.putpixel((x, y), color)
for name, orientation in [('plain', 1), ('gps', 1), ('irot', 8), ('imir', 2)]:
    exif = Image.Exif()
    exif[274] = orientation
    if name == 'gps':
        exif[270] = 'SYNTHETIC-GPS-SENTINEL'
    im.save(out / f'synthetic-{name}.heic', format='HEIF', quality=95, exif=exif.tobytes())
```
