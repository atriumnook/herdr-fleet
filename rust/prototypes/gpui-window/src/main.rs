//! Prototype for #108: opens one GPUI window that draws an English and a
//! Japanese line, so the window can be checked with `hyprctl clients -j` and
//! captured with `grim`.

use gpui::{
    App, Application, Bounds, Context, SharedString, TitlebarOptions, Window, WindowBounds,
    WindowOptions, div, prelude::*, px, rgb, size,
};

/// The Wayland app id, which `hyprctl clients -j` reports as `class`.
const APP_ID: &str = "herdr-fleet-gpui-window";
const TITLE: &str = "herdr-fleet GPUI prototype";

struct Lines {
    english: SharedString,
    japanese: SharedString,
}

impl Render for Lines {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_4()
            .size_full()
            .justify_center()
            .items_center()
            .bg(rgb(0xffffff))
            .text_color(rgb(0x1f2328))
            .text_size(px(40.))
            .child(self.english.clone())
            .child(self.japanese.clone())
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        // Without this the process keeps running after its window is closed.
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        let bounds = Bounds::centered(None, size(px(480.), px(240.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(TITLE.into()),
                ..Default::default()
            }),
            app_id: Some(APP_ID.to_owned()),
            ..Default::default()
        };
        cx.open_window(options, |window, cx| {
            // gpui 0.2.2's Wayland backend ignores `TitlebarOptions::title` (the
            // X11, macOS and Windows backends read it); on Wayland the title
            // reaches the compositor only through this call.
            window.set_window_title(TITLE);
            cx.new(|_| Lines {
                english: "herdr-fleet".into(),
                japanese: "承認待ち".into(),
            })
        })
        .expect("open the window");
        cx.activate(true);
    });
}
