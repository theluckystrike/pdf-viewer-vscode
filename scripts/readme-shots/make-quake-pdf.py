"""Builds data/earthquakes-october-2026.pdf from the real USGS ComCat CSV (M2.5+, 2026-10-01..2026-10-31)."""
import csv, collections, io, sys
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

rows = list(csv.DictReader(open(sys.argv[1])))
out = sys.argv[2]
mags = [float(r["mag"]) for r in rows]
big = sorted(rows, key=lambda r: -float(r["mag"]))
m45 = [r for r in rows if float(r["mag"]) >= 4.5]
deep = [r for r in rows if float(r["depth"]) >= 300]
def region(p):
    return p.split(", ")[-1] if ", " in p else p.replace("region", "").strip()
regions = collections.Counter(region(r["place"]) for r in m45).most_common(10)

def fig_png(fn, w, h):
    f = plt.figure(figsize=(w, h), dpi=200); fn(f); b = io.BytesIO(); f.savefig(b, format="png", facecolor=f.get_facecolor()); plt.close(f); b.seek(0); return b

def draw_map(f):
    f.patch.set_facecolor("#0b2545")
    ax = f.add_axes([0.04, 0.1, 0.84, 0.86]); ax.set_facecolor("#13315c")
    lon = [float(r["longitude"]) for r in rows]; lat = [float(r["latitude"]) for r in rows]
    dep = [float(r["depth"]) for r in rows]; size = [max(2, (float(r["mag"]) - 2) ** 2.6) for r in rows]
    sc = ax.scatter(lon, lat, s=size, c=dep, cmap="plasma_r", vmin=0, vmax=600, alpha=.85, linewidths=0)
    ax.set_xlim(-180, 180); ax.set_ylim(-70, 80)
    ax.grid(color="#8da9c4", alpha=.25, lw=.5)
    for s in ax.spines.values(): s.set_color("#8da9c4")
    ax.tick_params(colors="#eef4ed", labelsize=7)
    cb = f.colorbar(sc, cax=f.add_axes([0.9, 0.1, 0.02, 0.86])); cb.set_label("depth (km)", color="#eef4ed", fontsize=8)
    cb.ax.tick_params(colors="#eef4ed", labelsize=7)

def draw_hist(f):
    f.patch.set_facecolor("#ffffff")
    ax = f.add_axes([0.1, 0.18, 0.86, 0.75])
    bins = [x / 10 for x in range(25, 80, 2)]
    ax.hist(mags, bins=bins, color="#e76f51", edgecolor="#ffffff")
    ax.set_yscale("log"); ax.set_xlabel("magnitude", fontsize=8); ax.set_ylabel("events (log)", fontsize=8)
    ax.tick_params(labelsize=7); ax.spines[["top", "right"]].set_visible(False)

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontSize=20, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontSize=14, spaceBefore=10)
P = ParagraphStyle("P", parent=ss["BodyText"], fontSize=10.5, leading=15)

class Doc(SimpleDocTemplate):
    def afterFlowable(self, fl):
        if isinstance(fl, Paragraph) and fl.style.name in ("H1", "H2"):
            key = "k%d" % id(fl); self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(fl.getPlainText(), key, level=0 if fl.style.name == "H1" else 1)

doc = Doc(out, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
          title="Earthquakes, October 2026", author="Data: USGS ComCat")
W = A4[0] - 36 * mm
top = big[0]
story = [
    Paragraph("Earthquakes, October 2026", H1),
    Paragraph(f"A summary of {len(rows):,} earthquakes of magnitude 2.5 or more recorded worldwide by the USGS between 1 and 31 October 2026. "
              f"{len(m45):,} were magnitude 4.5 or more, and {len(deep):,} started deeper than 300 km.", P),
    Paragraph("1. Summary", H2),
    Paragraph(f"The largest event was a magnitude {float(top['mag']):g} earthquake {top['place']} on {top['time'][:10]}, at a depth of {float(top['depth']):g} km. "
              f"Most strong events sit on the Pacific Ring of Fire. Japan, Vanuatu and Papua New Guinea each had a busy month, and the deep events near the Bonin Islands, Japan region reached almost 500 km.", P),
    Spacer(1, 6),
    Image(fig_png(draw_map, 7.2, 3.4), width=W, height=W * 3.4 / 7.2),
    Paragraph("<i>Figure 1. Every M2.5+ event in October 2026. Dot size grows with magnitude, color shows depth.</i>", P),
    PageBreak(),
    Paragraph("2. Largest events", H2),
]
t = [["Date (UTC)", "Mag", "Depth km", "Place"]] + [[r["time"][:16].replace("T", " "), f"{float(r['mag']):g}", f"{float(r['depth']):g}", r["place"]] for r in big[:14]]
tbl = Table(t, colWidths=[34 * mm, 14 * mm, 20 * mm, W - 68 * mm])
tbl.setStyle(TableStyle([("FONT", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 9),
                         ("LINEBELOW", (0, 0), (-1, 0), .8, colors.black), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f1f1f1")]),
                         ("ALIGN", (1, 1), (2, -1), "RIGHT")]))
story += [tbl, Paragraph("2.1 Magnitudes", H2),
          Paragraph("The count of events falls about tenfold for each step of one in magnitude, as the Gutenberg-Richter law predicts.", P),
          Image(fig_png(draw_hist, 6.4, 2.6), width=W * .85, height=W * .85 * 2.6 / 6.4),
          Paragraph("<i>Figure 2. Events per magnitude bin, log scale.</i>", P),
          PageBreak(), Paragraph("3. Regions with the most M4.5+ events", H2)]
t2 = [["Region", "M4.5+ events"]] + [[k, str(v)] for k, v in regions]
tb2 = Table(t2, colWidths=[90 * mm, 30 * mm]); tb2.setStyle(TableStyle([("FONT", (0, 0), (-1, 0), "Helvetica-Bold"), ("LINEBELOW", (0, 0), (-1, 0), .8, colors.black), ("ALIGN", (1, 1), (1, -1), "RIGHT")]))
story += [tb2, Paragraph("Appendix A. Data source", H2),
          Paragraph("U.S. Geological Survey, ComCat earthquake catalog, query format=csv, minmagnitude=2.5, starttime=2026-10-01, endtime=2026-11-01, "
                    "downloaded 2026-11-06. USGS data are in the public domain. Values are as published; reviewed and automatic solutions are mixed.", P)]
doc.build(story)
print(out, len(rows), len(m45), regions[:3])
