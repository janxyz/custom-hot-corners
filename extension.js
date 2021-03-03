/* Copyright 2017 Jan Runge <janrunx@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const GObject = imports.gi.GObject;
const GLib = imports.gi.GLib;

const Main = imports.ui.main;
const Layout = imports.ui.layout;
const Ripples = imports.ui.ripples;
const Util = imports.misc.util;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Settings = Me.imports.settings;

let _origUpdateHotCorners = Main.layoutManager._updateHotCorners;
let _collector = [];

function init() {
}

function enable() {
    Main.layoutManager._updateHotCorners = _updateHotCorners;
    Main.layoutManager._updateHotCorners();
}

function disable() {
    // This restores the original hot corners
    _removeHotCorners();
    Main.layoutManager._updateHotCorners = _origUpdateHotCorners;
    Main.layoutManager._updateHotCorners();
}

function _removeHotCorners() {
    _collector.forEach(c => c.destroy());
    _collector = [];
    // hot corners might be null
    Main.layoutManager.hotCorners.filter(Boolean).forEach(c => c.destroy());
    Main.layoutManager.hotCorners = [];
}

function _updateHotCorners() {
    _removeHotCorners();
    Main.layoutManager.hotCorners=[];
    for (let i = 0; i < Main.layoutManager.monitors.length; ++i) {
        const corners = Settings.Corner.forMonitor(i, global.display.get_monitor_geometry(i));
        if (corners[2].action !== 'disabled' ||
            corners[3].action !== 'disabled' ||
            corners[2].click || corners[3].scroll) {
            // workaround for unclickable corners above focused windows under X11 session:
            //  add 1px high rectangle at the bottom of the monitor to move windows up
            fiX11(global.display.get_monitor_geometry(i))
        }
        for (let corner of corners) {
            _collector.push(corner);

            // Update hot corner if something changes
            corner.connect('changed', () => _updateCorner(corner));
            if (corner.action !== 'disabled') {
                Main.layoutManager.hotCorners.push(new CustomHotCorner(corner));
            }
        }
    }
}

function _updateCorner(corner) {
    destroyCorner(corner);
    if (corner.action !== 'disabled') {
        Main.layoutManager.hotCorners.push(new CustomHotCorner(corner));
    }
}

function destroyCorner(corner) {
    let hc=Main.layoutManager.hotCorners;
    for (let i = 0; i < hc.length; i++) {
        if (hc[i]._corner.top === corner.top &&
            hc[i]._corner.left === corner.left &&
            hc[i]._corner.monitorIndex === corner.monitorIndex)  {
                Main.layoutManager.hotCorners[i].destroy();
                Main.layoutManager.hotCorners.splice(i,1);
                break;
        }
    }
}

function fiX11(geometry) {
    let bottomSpacer = new Clutter.Rectangle({
        name: 'bootom-spacer',
        x: geometry.x, y: geometry.y + geometry.height - 1,
        width: geometry.width,
        height: 1,
        reactive: false,
        color: new Clutter.Color({
            red:0,
            green:0,
            blue:0,
            alpha:255
        })
    });
    _collector.push(bottomSpacer);
    Main.layoutManager.addChrome(bottomSpacer, {
            affectsStruts: true
        });
}

const CustomHotCorner = GObject.registerClass(
class CustomHotCorner extends Layout.HotCorner {
    _init(corner) {
        this._actionTimeoutId = null;
        let monitor = Main.layoutManager.monitors[corner.monitorIndex];
        super._init(Main.layoutManager, monitor, corner.x, corner.y);
        this._corner = corner;
        this._monitor = monitor;

        let m = new Map([
            ['toggleOverview', this._toggleOverview],
            ['showDesktop', this._showDesktop],
            ['showApplications', this._showApplications],
            ['runCommand', this._runCommand],
            ['switchToWorkspace', this._switchToWorkspace]
        ]);
        this._actionFunction = m.get(this._corner.action) || function () {};

        // Avoid pointer barriers that are at the same position
        // but block opposite directions. Neither with X nor with Wayland
        // such barriers work.
        for (let c of Main.layoutManager.hotCorners) {
            if (this._corner.x === c._corner.x && this._corner.y === c._corner.y) {
                if (this._corner.top === c._corner.top) {
                    this._corner.x += this._corner.left ? 1 : -1;
                } else if (this._corner.left === c._corner.left) {
                    this._corner.y += this._corner.top ? 1 : -1;
                }
            }
        }

        this._enterd = false;
        this._pressureBarrier = new Layout.PressureBarrier(
            corner.pressureThreshold,
            Layout.HOT_CORNER_PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW
        );
            this.setBarrierSize(corner.barrierSize);

        if (! (this._corner.click || this._corner.scroll || this._corner.switchWorkspace)) {
            this._pressureBarrier.connect('trigger', this._runAction.bind(this));
            this._setupFallbackCornerIfNeeded(Main.layoutManager);

        } else {
            this._cActor = new Clutter.Actor({
                name: 'click-corner',
                x: this._corner.x,
                y: this._corner.y,
                width: 3, height: 3,
                reactive: true,
                scale_x: this._corner.left ? 1 : -1,
                scale_y: this._corner.top ? 1 : -1
            });
            if (this._corner.click) {
                this._cActor.connect('button-press-event', this._onCornerClicked.bind(this));
            }
            if (this._corner.scroll || this._corner.switchWorkspace) {
                this._cActor.connect('scroll-event', this._onCornerScrolled.bind(this));
            }
            Main.layoutManager.addChrome(this._cActor);
            _collector.push(this._cActor);
        }

        // Rotate the ripple actors according to the corner.
        let ltr = (Clutter.get_default_text_direction() ==
                   Clutter.TextDirection.LTR);
        let angle = (this._corner.left && ltr) ? (this._corner.top ? 0 : 270) : (this._corner.top ? 90 : 180);
        this._ripples._ripple1.rotation_angle_z = angle;
        this._ripples._ripple2.rotation_angle_z = angle;
        this._ripples._ripple3.rotation_angle_z = angle;
    
    }

    // Overridden to allow all 4 monitor corners
    setBarrierSize(size) {
        // Use code of parent class to remove old barriers but new barriers
        // must be created here since the properties are construct only.
        super.setBarrierSize(0);

        if (size > 0) {
            const BD = Meta.BarrierDirection;
            this._verticalBarrier = new Meta.Barrier({
                display: global.display,
                x1: this._corner.x,
                x2: this._corner.x,
                y1: this._corner.y,
                y2: this._corner.top ? this._corner.y + size : this._corner.y - size,
                directions: this._corner.left ? BD.POSITIVE_X : BD.NEGATIVE_X
            });
            this._horizontalBarrier = new Meta.Barrier({
                display: global.display,
                x1: this._corner.x,
                x2: this._corner.left ? this._corner.x + size : this._corner.x - size,
                y1: this._corner.y,
                y2: this._corner.y,
                directions: this._corner.top ? BD.POSITIVE_Y : BD.NEGATIVE_Y
            });

            this._pressureBarrier.addBarrier(this._verticalBarrier);
            this._pressureBarrier.addBarrier(this._horizontalBarrier);
        }
    }

    // Overridden to allow all 4 monitor corners
    _setupFallbackCornerIfNeeded(layoutManager) {
        if (global.display.supports_extended_barriers() || this._corner.click || this._corner.click)
            return;
        this.actor = new Clutter.Actor({
            name: 'hot-corner-environs',
            x: this._corner.x, y: this._corner.y,
            width: 3, height: 3,
            reactive: true,
            scale_x: this._corner.left ? 1 : -1,
            scale_y: this._corner.top ? 1 : -1
        });

        this._cornerActor = new Clutter.Actor({
            name: 'hot-corner',
            x: 0, y: 0,
            width: 1, height: 1,
            reactive: true
        });

        this._cornerActor._delegate = this;
        this.actor.add_child(this._cornerActor);
        layoutManager.addChrome(this.actor);

        this.actor.connect('leave-event', this._onEnvironsLeft.bind(this));
        this._cornerActor.connect('enter-event', this._onCornerEntered.bind(this));
        this._cornerActor.connect('leave-event', this._onCornerLeft.bind(this));
    }

    _rippleAnimation() {
        this._ripples.playAnimation(this._corner.x, this._corner.y);
    }

    // Overridden to allow running custom actions
    _onCornerEntered() {
        if (!this._entered) {
            this._entered = true;
            this._runAction();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onCornerClicked(actor, event) {
        this._runAction();
        return Clutter.EVENT_STOP;
    }

    _onCornerScrolled(actor, event) {
        if (this._actionTimeoutId === null) {
            if (this._corner.switchWorkspace) {
                let direction = event.get_scroll_direction();
                _switchWorkspace(direction);
                return Clutter.EVENT_STOP;
            }
            this._runAction();
            if (this._actionTimeoutId !== null){
                GLib.Source.remove(this.actionTimeoutId);
                this._actionTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT,
                        200,
                        () => {
                            this._actionTimeoutId = null;
                        }
                );
            }
        }
        return Clutter.EVENT_STOP;
    }

    _runAction() {
        if (this._monitor.inFullscreen && this._corner.fullscreen) {
            this._actionFunction();
        } else if (!this._monitor.inFullscreen) {
            this._actionFunction();
        }
    }

    _toggleOverview() {
        if (Main.overview.shouldToggleByCornerOrButton()) {
            this._rippleAnimation();
            Main.overview.toggle();
        }
    }

    _showDesktop() {
        this._rippleAnimation();
        _togleShowDesktop()
    }

    _showApplications() {
        this._rippleAnimation();
        if (Main.overview.viewSelector._showAppsButton.checked) {
            Main.overview.hide();
        } else {
            Main.overview.viewSelector._toggleAppsPage();
        }
    }

    _runCommand() {
        this._rippleAnimation();
        Util.spawnCommandLine(this._corner.command);
    }

    _switchToWorkspace () {
        this._rippleAnimation();
        let idx = this._corner.workspaceIndex-1;
        let maxIndex = global.workspaceManager.n_workspaces-1;
        if (maxIndex < idx) {
            // last not empty workspace
            idx = maxIndex-1;
        }
        let ws = global.workspaceManager.get_workspace_by_index(idx);
        if (ws !== null) {
            Main.wm.actionMoveWorkspace(ws);
        }
    }
});

var _minimizedWindows = [];
function _togleShowDesktop() {
    let metaWorkspace = global.workspace_manager.get_active_workspace();
    let windows = metaWorkspace.list_windows();
    if (Main.overview.visible) {
        return;
    }
    if (!_minimizedWindows.length) {
        for ( let win of windows) {

            let wm_class = win.wm_class ? win.wm_class.toLowerCase() : 'null';
            let window_type = win.window_type ? win.window_type : 'null';
            let title = win.title ? win.title : 'null';

            if (  !(win.minimized ||
                    window_type == Meta.WindowType.DESKTOP ||
                    window_type == Meta.WindowType.DOCK ||
                    title.startsWith('DING') ||
                    wm_class.endsWith('notejot') ||
                    wm_class == 'conky' ||
                    ( title.startsWith('@!') && title.endsWith('BDH') ) )) {

                win.minimize();
                _minimizedWindows.push(win);
            }
        }
    } else {
        for ( let win of _minimizedWindows ) {
            win.unminimize();
        }
        _minimizedWindows = [];
    }
}

function _switchWorkspace(direction) {
        let motion;
        switch (direction) {
        case Clutter.ScrollDirection.UP:
            motion = Meta.MotionDirection.UP;
            break;
        case Clutter.ScrollDirection.DOWN:
            motion = Meta.MotionDirection.DOWN;
            break;
        case Clutter.ScrollDirection.LEFT:
            motion = Meta.MotionDirection.LEFT;
            break;
        case Clutter.ScrollDirection.RIGHT:
            motion = Meta.MotionDirection.RIGHT;
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        let activeWs = global.workspaceManager.get_active_workspace();
        let ws = activeWs.get_neighbor(motion);
        if(!ws) return Clutter.EVENT_STOP;
        Main.wm.actionMoveWorkspace(ws);
        return Clutter.EVENT_STOP;

}
