-- Clean up incompatible profile data from previous versions to prevent 500 errors
DELETE FROM profile_overlays;
DELETE FROM profile_files;

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profile_files' AND column_name='created') THEN
        ALTER TABLE "profile_files" ADD COLUMN "created" timestamp with time zone DEFAULT Now() NOT NULL;
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profile_files' AND column_name='updated') THEN
        ALTER TABLE "profile_files" ADD COLUMN "updated" timestamp with time zone DEFAULT Now() NOT NULL;
    END IF;
END $$;