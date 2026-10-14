//! Tray icon drawn from current limit usage: one vertical bar per limit, filled
//! bottom-up, so the most important numbers are visible without opening the app.

use serde::Deserialize;
use tauri::image::Image;

#[derive(Debug, Deserialize)]
pub struct TrayBar {
    pub pct: f64,
    /// "#rrggbb"
    pub color: String,
}

fn hex(c: &str) -> [u8; 3] {
    let c = c.trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(c.get(i..i + 2).unwrap_or("88"), 16).unwrap_or(0x88);
    [p(0), p(2), p(4)]
}

pub fn render(bars: &[TrayBar]) -> Image<'static> {
    const S: usize = 32;
    let mut px = vec![0u8; S * S * 4];
    let mut put = |x: usize, y: usize, c: [u8; 3]| {
        let i = (y * S + x) * 4;
        px[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
    };
    // rounded dark tile
    let r = 6.0f64;
    for y in 0..S {
        for x in 0..S {
            let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
            let cx = fx.clamp(r, S as f64 - r);
            let cy = fy.clamp(r, S as f64 - r);
            if (fx - cx).powi(2) + (fy - cy).powi(2) <= r * r {
                put(x, y, [0x1a, 0x1a, 0x19]);
            }
        }
    }
    let n = bars.len().clamp(1, 3);
    let (left, right, top, bottom) = (5usize, 27usize, 5usize, 27usize);
    let gap = 3usize;
    let width = (right - left - gap * (n - 1)) / n;
    for (i, b) in bars.iter().take(3).enumerate() {
        let x0 = left + i * (width + gap);
        let h = bottom - top;
        let filled = ((b.pct.clamp(0.0, 100.0) / 100.0) * h as f64).round() as usize;
        let color = if b.pct >= 90.0 { [0xd0, 0x3b, 0x3b] } else { hex(&b.color) };
        for y in top..bottom {
            for x in x0..x0 + width {
                let on = y >= bottom - filled;
                put(x, y, if on { color } else { [0x38, 0x38, 0x35] });
            }
        }
    }
    Image::new_owned(px, S as u32, S as u32)
}
