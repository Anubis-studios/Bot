import { useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogTitle } from "#renderer/ui/dialog";

/** A chat image that opens at full size over the window when clicked. */
export const ZoomableImage = ({
  className,
  alt = "",
  ...props
}: ComponentProps<"img">) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="block max-w-full cursor-zoom-in rounded-[inherit] focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:outline-none"
        aria-label={alt || t("chat.imageEnlarge")}
        title={t("chat.imageEnlarge")}
        onClick={() => setOpen(true)}
      >
        <img {...props} alt={alt} className={className} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-slot="image-lightbox"
          className="w-fit max-w-[calc(100vw-2rem)] bg-transparent p-0 ring-0 sm:max-w-[calc(100vw-2rem)]"
        >
          <DialogTitle className="sr-only">
            {alt || t("chat.imageEnlarge")}
          </DialogTitle>
          <img
            src={props.src}
            alt={alt}
            className="max-h-[calc(100vh-4rem)] max-w-[calc(100vw-2rem)] rounded-xl object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
};
