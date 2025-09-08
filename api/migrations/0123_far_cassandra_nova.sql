DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profile' AND column_name='display_icon_rotation') THEN
        ALTER TABLE "profile" ADD COLUMN "display_icon_rotation" boolean DEFAULT true NOT NULL;
    END IF;
END $$;
