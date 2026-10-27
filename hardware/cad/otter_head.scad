// Otter's two-axis head (lesson 9): a printed base, a pan yoke and a head tray
// for two Waveshare SC09 bus servos and the ESP32-S3-Touch-LCD-2.8 board.
//
// Servo 1 hangs in the base by its ears, shaft up, and turns the yoke left and
// right. Servo 2 hangs in the yoke's right arm, shaft pointing inward, and tilts
// the head; an M3x12 screw, clamped in a slot on the left arm, is the other end
// of the axis, sitting in a blind hole in the head.
// The tilt axis sits 12 mm above the board's centre, so the head hangs below it
// and stays upright when the servo is released.
//
// Units are mm. The screen faces -y (towards you); +x is your right.
// Export one part:  openscad -D 'part="yoke"' -o yoke.stl otter_head.scad
// part = "assembly" | "base" | "yoke" | "head" | "clip" | "layout" (preview of all four)

part = "assembly";
tilt = 0;  // preview only: head tilt in degrees
pan = 0;   // preview only: yoke turn in degrees

/* [Measured: SC09 servo] */
servo_len = 23.2;          // body length (Waveshare spec)
servo_wid = 12.0;          // body width (Waveshare spec)
servo_h = 22;              // body bottom to top face (estimated from a photo)
ear_from_bottom = 18;      // C: ear underside to body bottom
ear_span = 32;             // A
ear_hole_spacing = 29.5;   // B: 29-30
shaft_from_end = 5;        // D: shaft centre to the nearer end
ear_to_horn_top = 12.5;    // ear underside to the top face of a fitted horn (from C, E, photo)

/* [Measured: cross horn] */
horn_span = 25;            // F
horn_hole_spacing = 20;    // G: outermost holes, long arms
horn_t = 1.2;              // pocket depth for the arms (H about 1)

/* [Measured: board] */
board_w = 50.54;           // Waveshare spec
board_h = 73.06;           // Waveshare spec
board_t = 10;              // thickest point
connector_notch = 19;      // half width of the bottom opening: USB-C and servo lead

/* [Design] */
fit = 0.3;                 // clearance around parts that slide in
wall = 2.4;
back_t = 2;
lip = 1.5;                 // how far the front lips cover the board edge
lip_t = 1.6;
axis_above_centre = 12;    // tilt axis above the board centre
cable_room = 15;           // under the head, for the USB-C plug and its bend
pivot_gap = 6;             // left: head boss to arm, room for an M3 nut
boss_t = 3;                // horn boss and pivot boss
yoke_t = 5;
yoke_d = 28;
arm_t = 4;
base_size = 84;
base_h = 23;
plate_t = 3;
pilot = 1.6;               // self-tapping M2 screws: servo ears, horns, clip
$fn = 48;

// Derived
pocket_w = board_w + 2 * fit;
pocket_h = board_h + 2 * fit;
ox = pocket_w / 2 + wall;                       // head outer half width
y_front = -board_t / 2;                         // board front face
y_back = board_t / 2 + fit;                     // back plate inner face
y_min = y_front - lip_t;
y_max = y_back + back_t;
z_bot = -pocket_h / 2 - wall;
z_top = pocket_h / 2;
head_axis_z = axis_above_centre;                // in head coordinates
xr_in = ox + boss_t + ear_to_horn_top;          // right arm inner face (servo ears)
xl_in = -(ox + boss_t + pivot_gap);             // left arm inner face
axis_above_plate = pocket_h / 2 + wall + axis_above_centre + cable_room;
yoke_axis_z = yoke_t + axis_above_plate;        // in yoke coordinates (0 = plate underside)
arm_top = yoke_axis_z + 13;
servo_centre_off = shaft_from_end - servo_len / 2;  // body centre relative to shaft, along length

// A cross horn's outline, lying flat, arms along x and y, top face at z = 0.
module cross_pocket(depth) {
  for (a = [0, 90]) rotate([0, 0, a])
    hull() for (s = [-1, 1]) translate([s * (horn_span / 2 - 2.5), 0, -depth]) cylinder(d = 6, h = depth + 0.01);
  translate([0, 0, -depth]) cylinder(d = 9, h = depth + 0.01);
}

// Screw holes for the long arms (along x), pointing down from z = 0.
module horn_screws(depth) {
  for (s = [-1, 1]) translate([s * horn_hole_spacing / 2, 0, -depth]) cylinder(d = 1.5, h = depth + 0.01);
}

module base() {
  difference() {
    translate([-base_size / 2, -base_size / 2, 0]) cube([base_size, base_size, base_h]);
    translate([-base_size / 2 + wall, -base_size / 2 + wall, -1]) cube([base_size - 2 * wall, base_size - 2 * wall, base_h - plate_t + 1]);
    // servo body, shaft at the centre
    translate([shaft_from_end - servo_len - fit, -servo_wid / 2 - fit, base_h - plate_t - 1])
      cube([servo_len + 2 * fit, servo_wid + 2 * fit, plate_t + 2]);
    for (s = [-1, 1]) translate([servo_centre_off + s * ear_hole_spacing / 2, 0, base_h - plate_t - 1]) cylinder(d = pilot, h = plate_t + 2);
    // cable out the back
    translate([-9, base_size / 2 - wall - 1, -1]) cube([18, wall + 2, 9]);
  }
}

module yoke() {
  xl_out = xl_in - arm_t;
  xr_out = xr_in + arm_t;
  difference() {
    union() {
      translate([xl_out, -yoke_d / 2, 0]) cube([xr_out - xl_out, yoke_d, yoke_t]);
      translate([xr_in, -yoke_d / 2, 0]) cube([arm_t, yoke_d, arm_top]);
      translate([xl_out, -yoke_d / 2, 0]) cube([arm_t, yoke_d, arm_top]);
      // gussets on the outside of both arms
      for (side = [[xr_out, 1], [xl_out, -1]])
        translate([side[0], -yoke_d / 2, yoke_t]) rotate([90, 0, 0]) mirror([0, 0, 1])
          linear_extrude(yoke_d) polygon([[0, 0], [side[1] * 14, 0], [0, 18]]);
    }
    // pan horn on the underside, its centre screw from above
    translate([0, 0, horn_t]) cross_pocket(horn_t);
    for (s = [-1, 1]) translate([s * horn_hole_spacing / 2, 0, -1]) cylinder(d = 1.5, h = horn_t + 4.5);
    translate([0, 0, -1]) cylinder(d = 6.5, h = yoke_t + 2);
    // servo 2 through the right arm, shaft end up
    translate([xr_in - 1, -servo_wid / 2 - fit, yoke_axis_z + shaft_from_end - servo_len - fit])
      cube([arm_t + 2, servo_wid + 2 * fit, servo_len + 2 * fit]);
    for (s = [-1, 1]) translate([xr_in - 1, 0, yoke_axis_z + servo_centre_off + s * ear_hole_spacing / 2])
      rotate([0, 90, 0]) cylinder(d = pilot, h = arm_t + 2);
    // M3 pivot slot: set the screw level with servo 2's shaft
    hull() for (dz = [-5, 2]) translate([xl_out - 1, 0, yoke_axis_z + dz]) rotate([0, 90, 0]) cylinder(d = 3.4, h = arm_t + 2);
  }
}

module head() {
  difference() {
    union() {
      translate([-ox, y_back, z_bot]) cube([2 * ox, back_t, z_top - z_bot]);
      for (s = [-1, 1]) translate([s > 0 ? pocket_w / 2 : -ox, y_min, z_bot]) cube([wall, y_back - y_min, z_top - z_bot]);
      translate([-ox, y_min, z_bot]) cube([2 * ox, y_back - y_min, wall]);
      // front lips, sides and bottom
      translate([-pocket_w / 2, y_min, z_bot]) cube([pocket_w, lip_t, z_top - z_bot]);
      // blocks for the top clip screws
      for (s = [-1, 1]) translate([s > 0 ? ox : -ox - 5, y_min, z_top - 9]) cube([5, y_max - y_min, 9]);
      // horn boss (right) and pivot boss (left), trimmed to the head's depth
      intersection() {
        union() {
          translate([ox, 0, head_axis_z]) rotate([0, 90, 0]) cylinder(d = 28, h = boss_t);
          translate([-ox - boss_t, 0, head_axis_z]) rotate([0, 90, 0]) cylinder(d = 10, h = boss_t);
        }
        translate([-ox - boss_t - 1, y_min, -100]) cube([2 * ox + 2 * boss_t + 2, y_max - y_min, 200]);
      }
    }
    // the board
    translate([-pocket_w / 2, y_front, -pocket_h / 2]) cube([pocket_w, y_back - y_front, pocket_h + 1]);
    // screen opening, leaving the lips
    translate([-pocket_w / 2 + lip, y_min - 1, -pocket_h / 2 + lip]) cube([pocket_w - 2 * lip, lip_t + 2, pocket_h]);
    // bottom opening: USB-C and the servo lead
    translate([-connector_notch, y_min - 1, z_bot - 1]) cube([2 * connector_notch, y_max - y_min + 2, wall + lip + 1]);
    // back window
    translate([-19, y_back - 1, -30]) cube([38, back_t + 2, 56]);
    // speaker plug on the left edge
    translate([-ox - 1, y_min - 1, -6]) cube([wall + lip + 1, y_back - y_min + 1, 12]);
    // horn: pocket, two screws (long arms vertical), centre screw access from inside
    translate([ox + boss_t, 0, head_axis_z]) rotate([0, 90, 0]) {
      cross_pocket(horn_t);
      horn_screws(5);
    }
    translate([pocket_w / 2 - 1, 0, head_axis_z]) rotate([0, 90, 0]) cylinder(d = 6.5, h = wall + boss_t + 2);
    // M3 pivot: blind, so the screw end stays out of the board's pocket
    translate([-ox - boss_t - 1, 0, head_axis_z]) rotate([0, 90, 0]) cylinder(d = 3.4, h = boss_t + 2);
    // top clip screws
    for (s = [-1, 1]) translate([s * (ox + 2.5), (y_min + y_max) / 2, z_top - 8]) cylinder(d = pilot, h = 9);
  }
}

module clip() {
  difference() {
    union() {
      translate([-ox - 5, y_min, z_top]) cube([2 * ox + 10, y_max - y_min, wall]);
      translate([-pocket_w / 2 + lip, y_min, z_top - lip]) cube([pocket_w - 2 * lip, lip_t, lip + 0.01]);
    }
    for (s = [-1, 1]) translate([s * (ox + 2.5), (y_min + y_max) / 2, z_top - 1]) cylinder(d = 2.3, h = wall + 2);
  }
}

// Stand-ins for the preview only.
module servo_dummy() {  // shaft at the origin pointing +z, ear underside at z = 0
  color("#2C2C2A") {
    translate([shaft_from_end - servo_len, -servo_wid / 2, -ear_from_bottom]) cube([servo_len, servo_wid, servo_h]);
    translate([servo_centre_off - ear_span / 2, -3.5, 0]) cube([ear_span, 7, 2]);
    translate([0, 0, servo_h - ear_from_bottom]) cylinder(d = 11, h = ear_to_horn_top - (servo_h - ear_from_bottom) - horn_t);
  }
  color("white") translate([0, 0, ear_to_horn_top]) cross_pocket(horn_t);
}
module board_dummy() {
  color("#1f1f1f") translate([-board_w / 2, y_front, -board_h / 2]) cube([board_w, board_t, board_h]);
  color("#FAEEDA") translate([-21.6, y_front - 0.1, -28.8]) cube([43.2, 0.2, 57.6]);
}

module assembly() {
  base_c = [0.85, 0.72, 0.55];
  color(base_c) base();
  translate([0, 0, base_h]) servo_dummy();
  rotate([0, 0, pan]) translate([0, 0, base_h + ear_to_horn_top]) {
    color([0.94, 0.62, 0.15]) yoke();
    translate([xr_in, 0, yoke_axis_z]) rotate([0, -90, 0]) servo_dummy();
    translate([0, 0, yoke_axis_z]) rotate([-tilt, 0, 0]) translate([0, 0, -head_axis_z]) {
      color([0.11, 0.62, 0.46]) head();
      color([0.36, 0.79, 0.65]) clip();
      board_dummy();
    }
  }
}

// Each part lies the way it prints best.
if (part == "assembly") assembly();
else if (part == "base") translate([0, 0, base_h]) rotate([180, 0, 0]) base();
else if (part == "yoke") yoke();
else if (part == "head") translate([0, 0, y_max]) rotate([-90, 0, 0]) head();
else if (part == "clip") translate([0, 0, z_top + wall]) rotate([180, 0, 0]) clip();
else if (part == "layout") {  // all four as they print, for a preview
  color([0.85, 0.72, 0.55]) translate([-110, 0, 0]) translate([0, 0, base_h]) rotate([180, 0, 0]) base();
  color([0.94, 0.62, 0.15]) translate([10, -40, 0]) yoke();
  color([0.11, 0.62, 0.46]) translate([10, 55, 0]) translate([0, 0, y_max]) rotate([-90, 0, 0]) head();
  color([0.36, 0.79, 0.65]) translate([-110, 75, 0]) translate([0, 0, z_top + wall]) rotate([180, 0, 0]) clip();
}
