ALTER TABLE "video_lease" ADD COLUMN "layer" integer;--> statement-breakpoint
ALTER TABLE "video_lease" ADD CONSTRAINT "video_lease_layer_layers_id_fk" FOREIGN KEY ("layer") REFERENCES "public"."layers"("id") ON DELETE no action ON UPDATE no action;
