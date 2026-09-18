#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纯 Python 标准库生成「无人深空 · 电力模拟器」桌面客户端图标（build/icon.ico）。

主题：深色科幻底 + 青色闪电 + 电路节点/走线。
实现：不依赖 Pillow，自行绘制 RGBA 位图（含超采样抗锯齿），
      逐尺寸渲染 16/32/48/64/128/256，手工封装成多尺寸 ICO（内嵌 PNG）。
"""

import struct
import zlib
import os

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'build')
OUTPUT_ICO = os.path.join(OUTPUT_DIR, 'icon.ico')

SIZES = [256, 128, 64, 48, 32, 16]

# 颜色（RGBA）
BG = (11, 16, 21, 255)          # #0b1015 深色科幻底
TRACE = (40, 199, 255, 210)     # #28c7ff 青色走线 / 边框
BOLT = (89, 226, 255, 255)      # #59e2ff 闪电主体（亮青）
BOLT_CORE = (214, 250, 255, 255)  # 闪电高光
NODE = (40, 199, 255, 255)      # 电路节点
NODE_GLOW = (40, 199, 255, 70)  # 节点光晕

SS = 3  # 每个像素每边的超采样数（SS*SS 采样，用于抗锯齿）

# 24 单位坐标系（与源应用 favicon 的闪电路径一致）
# M14 2 L5 14 h6 l-3 10 L19 10 h-5 z
BOLT_POLY_24 = [(14, 2), (5, 14), (11, 14), (8, 22), (19, 10), (14, 10)]


def lerp(a, b, t):
    return a + (b - a) * t


def blend(dst, src):
    """把 src 前景色按 alpha 混合到 dst 背景色上，返回新的 RGBA 元组。"""
    sa = src[3] / 255.0
    da = dst[3] / 255.0
    out_a = sa + da * (1.0 - sa)
    if out_a <= 0:
        return (0, 0, 0, 0)
    r = (src[0] * sa + dst[0] * da * (1.0 - sa)) / out_a
    g = (src[1] * sa + dst[1] * da * (1.0 - sa)) / out_a
    b = (src[2] * sa + dst[2] * da * (1.0 - sa)) / out_a
    return (int(round(r)), int(round(g)), int(round(b)), int(round(out_a * 255)))


def point_in_poly(x, y, poly):
    """射线法判断点是否在多边形内部。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


class Canvas:
    """size×size 的 RGBA 画布，坐标采用 0..256 的归一化空间（自动缩放）。"""

    def __init__(self, size):
        self.size = size
        self.k = size / 256.0
        self.buf = bytearray(size * size * 4)

    def _idx(self, x, y):
        return (y * self.size + x) * 4

    def _put(self, x, y, color):
        idx = self._idx(x, y)
        cur = (self.buf[idx], self.buf[idx + 1], self.buf[idx + 2], self.buf[idx + 3])
        out = blend(cur, color)
        self.buf[idx:idx + 4] = bytearray(out)

    def fill_rounded_rect(self, x0, y0, w, h, r, color):
        """实心圆角矩形（坐标 0..256 空间）。"""
        k = self.k
        X0, Y0, W, H, R = x0 * k, y0 * k, w * k, h * k, r * k
        x_lo = max(0, int(X0) - 1)
        x_hi = min(self.size, int(X0 + W) + 2)
        y_lo = max(0, int(Y0) - 1)
        y_hi = min(self.size, int(Y0 + H) + 2)

        for py in range(y_lo, y_hi):
            for px in range(x_lo, x_hi):
                hits = 0
                for sy in range(SS):
                    for sx in range(SS):
                        fx = px + (sx + 0.5) / SS
                        fy = py + (sy + 0.5) / SS
                        dx = max(X0 - fx, 0.0, fx - (X0 + W))
                        dy = max(Y0 - fy, 0.0, fy - (Y0 + H))
                        dist = (dx * dx + dy * dy) ** 0.5 - R
                        if dist <= 0:
                            hits += 1
                if hits:
                    cov = hits / (SS * SS)
                    c = (color[0], color[1], color[2], int(color[3] * cov))
                    self._put(px, py, c)

    def fill_polygon(self, poly, color):
        """实心多边形（坐标 0..256 空间），超采样抗锯齿。"""
        k = self.k
        pts = [(x * k, y * k) for (x, y) in poly]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x_lo = max(0, int(min(xs)) - 1)
        x_hi = min(self.size, int(max(xs)) + 2)
        y_lo = max(0, int(min(ys)) - 1)
        y_hi = min(self.size, int(max(ys)) + 2)

        for py in range(y_lo, y_hi):
            for px in range(x_lo, x_hi):
                hits = 0
                for sy in range(SS):
                    for sx in range(SS):
                        fx = px + (sx + 0.5) / SS
                        fy = py + (sy + 0.5) / SS
                        if point_in_poly(fx, fy, pts):
                            hits += 1
                if hits:
                    cov = hits / (SS * SS)
                    c = (color[0], color[1], color[2], int(color[3] * cov))
                    self._put(px, py, c)

    def fill_circle(self, cx, cy, r, color):
        """实心圆（坐标 0..256 空间），超采样抗锯齿。"""
        k = self.k
        CX, CY, R = cx * k, cy * k, r * k
        x_lo = max(0, int(CX - R) - 1)
        x_hi = min(self.size, int(CX + R) + 2)
        y_lo = max(0, int(CY - R) - 1)
        y_hi = min(self.size, int(CY + R) + 2)

        for py in range(y_lo, y_hi):
            for px in range(x_lo, x_hi):
                hits = 0
                for sy in range(SS):
                    for sx in range(SS):
                        fx = px + (sx + 0.5) / SS
                        fy = py + (sy + 0.5) / SS
                        if ((fx - CX) ** 2 + (fy - CY) ** 2) ** 0.5 <= R:
                            hits += 1
                if hits:
                    cov = hits / (SS * SS)
                    c = (color[0], color[1], color[2], int(color[3] * cov))
                    self._put(px, py, c)

    def fill_line(self, x1, y1, x2, y2, width, color):
        """粗线段（坐标 0..256 空间）。"""
        k = self.k
        ax, ay, bx, by, w = x1 * k, y1 * k, x2 * k, y2 * k, width * k
        x_lo = max(0, int(min(ax, bx) - w) - 1)
        x_hi = min(self.size, int(max(ax, bx) + w) + 2)
        y_lo = max(0, int(min(ay, by) - w) - 1)
        y_hi = min(self.size, int(max(ay, by) + w) + 2)
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy or 1e-9

        for py in range(y_lo, y_hi):
            for px in range(x_lo, x_hi):
                hits = 0
                for sy in range(SS):
                    for sx in range(SS):
                        fx = px + (sx + 0.5) / SS
                        fy = py + (sy + 0.5) / SS
                        t = ((fx - ax) * dx + (fy - ay) * dy) / seg2
                        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                        cx, cy = ax + t * dx, ay + t * dy
                        if ((fx - cx) ** 2 + (fy - cy) ** 2) ** 0.5 <= w / 2.0:
                            hits += 1
                if hits:
                    cov = hits / (SS * SS)
                    c = (color[0], color[1], color[2], int(color[3] * cov))
                    self._put(px, py, c)

    def to_png(self):
        """把 RGBA 缓冲编码成 PNG。"""
        def chunk(type_name, data):
            type_bytes = type_name.encode('ascii')
            payload = type_bytes + data
            return (struct.pack('>I', len(data)) + payload +
                    struct.pack('>I', zlib.crc32(payload) & 0xffffffff))

        raw = bytearray()
        row = self.size * 4
        for y in range(self.size):
            raw.append(0)  # filter: None
            raw.extend(self.buf[y * row:(y + 1) * row])
        ihdr = struct.pack('>IIBBBBB', self.size, self.size, 8, 6, 0, 0, 0)
        out = bytearray()
        out.extend(b'\x89PNG\r\n\x1a\n')
        out.extend(chunk('IHDR', ihdr))
        out.extend(chunk('IDAT', zlib.compress(bytes(raw), 9)))
        out.extend(chunk('IEND', b''))
        return bytes(out)


def draw_icon(size):
    """渲染指定尺寸的图标并返回 PNG 字节。坐标使用 0..256 归一化空间。"""
    c = Canvas(size)

    # 1) 深色圆角底
    c.fill_rounded_rect(10, 10, 236, 236, 52, BG)

    # 2) 青色电路边框（外框青色，内框深色，形成描边环）
    c.fill_rounded_rect(10, 10, 236, 236, 52, TRACE)
    c.fill_rounded_rect(16, 16, 224, 224, 46, BG)

    # 3) 底部电路走线：一条折线 + 两端节点
    c.fill_line(60, 212, 120, 212, 5, TRACE)
    c.fill_line(120, 212, 150, 232, 5, TRACE)
    c.fill_line(150, 232, 196, 232, 5, TRACE)

    # 4) 顶部走线：从左侧节点连到闪电上方
    c.fill_line(60, 44, 108, 44, 5, TRACE)

    # 5) 电路节点（外发光 + 实心点）
    nodes = [(60, 44, 14), (60, 212, 16), (196, 232, 16)]
    for (nx, ny, nr) in nodes:
        c.fill_circle(nx, ny, nr + 6, NODE_GLOW)
        c.fill_circle(nx, ny, nr, NODE)

    # 6) 闪电：把 24 单位坐标系映射到以 (128,128) 为中心、高约 150 的图标空间
    s = 7.5
    off = 128.0 - 12.0 * s  # 源坐标系中心 (12,12) 对齐到图标中心

    def T(pt):
        return (pt[0] * s + off, pt[1] * s + off)

    c.fill_polygon([T(p) for p in BOLT_POLY_24], BOLT)
    # 高光：三角形内缩的一小段（提升立体感）
    c.fill_polygon([T(p) for p in [(13.2, 4.2), (8.0, 12.4), (13.0, 12.4)]], BOLT_CORE)

    return c.to_png()


def make_ico(images):
    """把一组 PNG（含各自尺寸）封装成多尺寸 ICO。"""
    count = len(images)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries = bytearray()
    payload = bytearray()
    for size, png in images:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        entries.extend(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), offset))
        payload.extend(png)
        # 每张图数据 4 字节对齐
        pad = (-len(png)) % 4
        if pad:
            payload.extend(b'\x00' * pad)
        offset += len(png) + pad
    return bytes(header + entries + payload)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    images = []
    for size in SIZES:
        png = draw_icon(size)
        images.append((size, png))
        print(f'  渲染 {size}x{size}: {len(png)} 字节 PNG')

    ico = make_ico(images)
    with open(OUTPUT_ICO, 'wb') as f:
        f.write(ico)

    print(f'图标已生成：{OUTPUT_ICO}')
    print(f'文件大小：{len(ico)} 字节，包含 {len(images)} 个尺寸：{" ".join(str(s) for s in SIZES)}')

    # 校验 ICO 头部
    with open(OUTPUT_ICO, 'rb') as f:
        head = f.read(6)
    reserved, itype, icount = struct.unpack('<HHH', head)
    if head[:4] == b'\x00\x00\x01\x00' and icount == len(SIZES):
        print(f'ICO 头部校验通过（{icount} 个图像条目）')
    else:
        print(f'ICO 头部异常：{head.hex()}')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
