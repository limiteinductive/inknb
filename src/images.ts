import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { passageAnnotationSchema, passageReferenceSchema, messageAnnotationSchema } from "./passage-reference";

export async function copyImage(image: HTMLImageElement): Promise<void> {
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw Error("Could not copy this image.");
  context.drawImage(image, 0, 0);
  await invoke("image_copy", { data: canvas.toDataURL("image/png").split(",")[1] });
}


export const imageSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string(),
  path: z.string().startsWith("/"),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});
export type ImageAsset = z.infer<typeof imageSchema>;
export const draftSchema = z.object({
  content: z.string(),
  references: z.array(passageReferenceSchema).optional(),
  annotations: z.array(messageAnnotationSchema).optional(),
  annotation: passageAnnotationSchema.optional(),
  recipientAgentId: z.string().nullable().optional(),
  images: z.array(imageSchema).default([]),
});
export type AsideDraft = z.infer<typeof draftSchema>;

export function clipboardImages(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
}

export async function importImages(files: File[]): Promise<ImageAsset[]> {
  const images: ImageAsset[] = [];
  for (const file of files) {
    if (file.size > 12 * 1024 * 1024)
      throw Error("Paste images smaller than 12 MB each.");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(Error("Could not read the pasted image."));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    image.src = data;
    await image.decode();
    images.push(
      imageSchema.parse(
        await invoke("image_import", {
          data: data.slice(data.indexOf(",") + 1),
          name: file.name || "Pasted image",
        }),
      ),
    );
  }
  return images;
}
