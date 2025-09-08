DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers' AND column_name='alarm_period') THEN
        ALTER TABLE "layers" ADD COLUMN "alarm_period" integer DEFAULT 30 NOT NULL;
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers' AND column_name='alarm_evals') THEN
        ALTER TABLE "layers" ADD COLUMN "alarm_evals" integer DEFAULT 5 NOT NULL;
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers' AND column_name='alarm_points') THEN
        ALTER TABLE "layers" ADD COLUMN "alarm_points" integer DEFAULT 4 NOT NULL;
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers' AND column_name='alarm_threshold') THEN
        ALTER TABLE "layers" ADD COLUMN "alarm_threshold" integer DEFAULT 0 NOT NULL;
    END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers_incoming' AND column_name='alarm_period') THEN
        UPDATE "layers"
            SET
                "alarm_period"      = "layers_incoming"."alarm_period",
                "alarm_evals"       = "layers_incoming"."alarm_evals",
                "alarm_points"      = "layers_incoming"."alarm_points",
                "alarm_threshold"   = "layers_incoming"."alarm_threshold"
            FROM
                "layers_incoming"
            WHERE
                "layers"."id" = "layers_incoming"."layer";
    END IF;
END $$;--> statement-breakpoint

DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers_incoming' AND column_name='alarm_period') THEN
        ALTER TABLE "layers_incoming" DROP COLUMN "alarm_period";
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers_incoming' AND column_name='alarm_evals') THEN
        ALTER TABLE "layers_incoming" DROP COLUMN "alarm_evals";
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers_incoming' AND column_name='alarm_points') THEN
        ALTER TABLE "layers_incoming" DROP COLUMN "alarm_points";
    END IF;
END $$;--> statement-breakpoint
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='layers_incoming' AND column_name='alarm_threshold') THEN
        ALTER TABLE "layers_incoming" DROP COLUMN "alarm_threshold";
    END IF;
END $$;
