import { describe, expect, it } from "vitest";
import { detectImageEditing } from "./exif";

describe("detectImageEditing: ausencia de metadatos", () => {
  it("no marca como sospechosa una imagen sin EXIF", () => {
    // Es el caso normal, no la excepción: WhatsApp borra el EXIF de todo lo que
    // reenvía y por ahí llega la mayoría de los comprobantes. Penalizarlo
    // castigaría a casi todos los clientes honestos.
    expect(detectImageEditing(null).tieneExifDeEditor).toBe(false);
    expect(detectImageEditing({}).tieneExifDeEditor).toBe(false);
  });

  it("deja constancia de que la comprobación se hizo y no dio información", () => {
    const { señales } = detectImageEditing(null);
    expect(señales).toHaveLength(1);
    expect(señales[0]).toContain("WhatsApp");
  });
});

describe("detectImageEditing: editores conocidos", () => {
  const editores = [
    "Adobe Photoshop 25.1 (Windows)",
    "Adobe Photoshop Lightroom 7.2",
    "GIMP 2.10.34",
    "Snapseed 2.21.0.56697644",
    "PicsArt 24.3.1",
    "Canva",
    "Pixlr",
    "paint.net 5.0",
    "Affinity Photo 2",
    "Photopea",
  ];

  for (const software of editores) {
    it(`detecta "${software}" en el campo Software`, () => {
      const resultado = detectImageEditing({ Software: software });
      expect(resultado.tieneExifDeEditor).toBe(true);
      expect(resultado.señales.some((s) => s.includes(software))).toBe(true);
    });
  }

  it("es insensible a mayúsculas en el valor", () => {
    expect(detectImageEditing({ Software: "ADOBE PHOTOSHOP CC" }).tieneExifDeEditor).toBe(true);
    expect(detectImageEditing({ Software: "gimp" }).tieneExifDeEditor).toBe(true);
  });

  it("es insensible a mayúsculas en el nombre del campo", () => {
    // Cada librería y cada cámara normaliza la clave a su manera.
    for (const clave of ["software", "SOFTWARE", "Software"]) {
      expect(detectImageEditing({ [clave]: "GIMP 2.10" }).tieneExifDeEditor).toBe(true);
    }
  });

  it("revisa ProcessingSoftware además de Software", () => {
    expect(detectImageEditing({ ProcessingSoftware: "Photoshop" }).tieneExifDeEditor).toBe(true);
  });

  it("revisa los campos de XMP, donde Photoshop deja rastro aunque limpie Software", () => {
    expect(detectImageEditing({ CreatorTool: "Adobe Photoshop 25.1" }).tieneExifDeEditor).toBe(true);
    expect(
      detectImageEditing({ HistorySoftwareAgent: ["Adobe Photoshop 25.1", "Adobe Photoshop 25.1"] })
        .tieneExifDeEditor,
    ).toBe(true);
  });

  it("nombra el campo y el valor encontrados para que el admin pueda juzgar", () => {
    const { señales } = detectImageEditing({ Software: "Snapseed 2.21" });
    expect(señales[0]).toBe('Campo Software nombra un editor de imágenes: "Snapseed 2.21".');
  });

  it("advierte de los falsos positivos junto a la detección", () => {
    // El texto termina en la pantalla del admin, sin el contexto del módulo.
    const { señales } = detectImageEditing({ Software: "Snapseed 2.21" });
    expect(señales.some((s) => s.includes("no prueba fraude"))).toBe(true);
  });
});

describe("detectImageEditing: metadatos de captura legítima", () => {
  it("no marca el software de un celular como editor", () => {
    const resultado = detectImageEditing({
      Make: "samsung",
      Model: "SM-A546E",
      Software: "A546EXXU7CXH1",
    });
    expect(resultado.tieneExifDeEditor).toBe(false);
  });

  it("no marca la versión de iOS de una captura de iPhone", () => {
    expect(detectImageEditing({ Software: "18.3.1", Make: "Apple" }).tieneExifDeEditor).toBe(false);
  });

  it("informa que hay EXIF pero sin rastro de editores", () => {
    const { señales } = detectImageEditing({ Make: "Xiaomi", Software: "MIUI Camera" });
    expect(señales).toHaveLength(1);
    expect(señales[0]).toContain("sin rastro de editores");
  });
});

describe("detectImageEditing: robustez", () => {
  it("ignora campos que no son texto sin reventar", () => {
    const resultado = detectImageEditing({
      Software: null,
      ProcessingSoftware: 42,
      CreatorTool: { nombre: "photoshop" },
      Orientation: 6,
    });
    expect(resultado.tieneExifDeEditor).toBe(false);
  });

  it("acumula una señal por cada campo que nombre un editor", () => {
    const resultado = detectImageEditing({
      Software: "Adobe Photoshop 25.1",
      CreatorTool: "Canva",
    });
    expect(resultado.tieneExifDeEditor).toBe(true);
    // Dos hallazgos más la nota sobre falsos positivos.
    expect(resultado.señales).toHaveLength(3);
  });

  it("detecta el editor aunque venga entre otros metadatos irrelevantes", () => {
    const resultado = detectImageEditing({
      ExifImageWidth: 1080,
      DateTimeOriginal: "2026:04:15 21:12:03",
      Software: "PicsArt",
      ColorSpace: 1,
    });
    expect(resultado.tieneExifDeEditor).toBe(true);
  });
});
