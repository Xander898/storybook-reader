# 生成 E2E 测试用「剧情书页」图片：模拟剧情书版式（段号 + 正文 + 跳转提示 + 插图）
# 页1：段 0001/0002（含"查看 0003 段落"跳转）/0003（半段，跨页），底部有大块插图区域
# 页2：首行无段号（续文，验证跨页合并）+ 段 0004（含两个跳转）
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
W, H = 900, 1300

def make_page(lines, illustration_at=None, path=None):
    img = Image.new("RGB", (W, H), "#ffffff")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 38)
    y = 60
    for text in lines:
        d.text((70, y), text, font=font, fill="#111111")
        y += 72
    if illustration_at is not None:
        top = illustration_at
        # 模拟书里插图的彩色场景块（山、月、城堡剪影）
        d.rectangle([90, top, W - 90, top + 320], fill="#2c3e70")
        d.ellipse([W - 260, top + 30, W - 160, top + 130], fill="#f5e6a8")  # 月亮
        d.polygon([(120, top + 320), (300, top + 140), (470, top + 320)], fill="#5b6ea3")  # 山
        d.polygon([(430, top + 320), (620, top + 110), (810, top + 320)], fill="#7a8cbf")
        d.rectangle([640, top + 190, 700, top + 320], fill="#3a2f28")  # 塔楼
    img.save(path)
    print("saved", path)

make_page(
    [
        "0001 你推开城堡的大门，夜色笼罩着高塔。",
        "0002 你沿着石阶向上，听见远处的狼嚎。查看 0003 段落，继续上山。",
        "0003 你来到塔顶，火焰在炉中跳动。",
    ],
    illustration_at=420,
    path="e2e/page1.png",
)

make_page(
    [
        "你发现一本古书静静躺在桌上，封面刻着奇异花纹。",
        "0004 你翻开书页，文字泛起蓝光。查看 0002 段落。",
    ],
    path="e2e/page2.png",
)

# 两页 PDF（PIL 直接多页导出）
p1 = Image.open("e2e/page1.png")
p2 = Image.open("e2e/page2.png")
p1.save("e2e/testbook.pdf", save_all=True, append_images=[p2])
print("saved e2e/testbook.pdf")
