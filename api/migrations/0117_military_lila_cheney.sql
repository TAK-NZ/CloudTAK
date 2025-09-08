DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profile_videos' AND column_name='lease') THEN
        ALTER TABLE "profile_videos" ADD COLUMN "lease" integer NOT NULL;
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='profile_videos_lease_video_lease_id_fk') THEN
        ALTER TABLE "profile_videos" ADD CONSTRAINT "profile_videos_lease_video_lease_id_fk" FOREIGN KEY ("lease") REFERENCES "public"."video_lease"("id") ON DELETE no action ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profile_videos' AND column_name='url') THEN
        ALTER TABLE "profile_videos" DROP COLUMN "url";
    END IF;
END $$;
