-- DropForeignKey
ALTER TABLE "owner_statements" DROP CONSTRAINT "owner_statements_propertyId_fkey";

-- AddForeignKey
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
