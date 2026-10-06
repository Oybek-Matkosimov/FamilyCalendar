ALTER TABLE "calendars" ADD CONSTRAINT "calendars_owner_fk" FOREIGN KEY ("owner_member_id") REFERENCES "members"("id") DEFERRABLE INITIALLY DEFERRED;
